#!/usr/bin/env python3
"""Apply reviewed formula replacements to a copied XLSX workbook.

Every replacement is bound to the source workbook hash and the exact formula
currently present in its cell.  The source is never edited; output publication
and receipt publication are staged and rolled back together.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.dom import minidom
from xml.etree import ElementTree as ET

from gg_excel_template import (
    NS_MAIN,
    _dom_attr,
    _dom_elements,
    _dom_invalidate_formula_cache,
    _serialize_dom,
    merged_cells,
    sha256,
    workbook_sheets,
)


MAP_SCHEMA = "gg-xlsx-formula-patch-map/v1"
_UNSAFE_FORMULA = re.compile(r"(?:\[[^\]]+\]|\bDDE\s*\(|#REF!|EXTERNAL|\||\b(?:WEBSERVICE|HYPERLINK)\s*\()", re.I)


def _json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {path}")
    return value


def _formula_text(cell: ET.Element) -> str | None:
    f = cell.find(f"{{{NS_MAIN}}}f")
    return None if f is None else (f.text or "")


def _normalize_formula(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty formula string")
    formula = value.strip()
    if formula.startswith("="):
        formula = formula[1:]
    if not formula or _UNSAFE_FORMULA.search(formula):
        raise ValueError(f"unsafe external/DDE formula in {field}")
    return formula


def _expected_number(value: object) -> int | float:
    """Validate a finite numeric precondition for a value-to-formula patch."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("expected_value must be a finite number")
    try:
        finite = Decimal(str(value)).is_finite()
    except (InvalidOperation, ValueError):
        finite = False
    if not finite:
        raise ValueError("expected_value must be a finite number")
    return value


def _patches(data: dict) -> list[dict]:
    if data.get("schema") != MAP_SCHEMA:
        raise ValueError(f"map schema must be {MAP_SCHEMA}")
    source = data.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("sha256"), str):
        raise ValueError("map must contain source.sha256")
    patches = data.get("patches", data.get("entries"))
    if not isinstance(patches, list) or not patches:
        raise ValueError("map must contain non-empty patches")
    return patches


def _evidence(patch: dict) -> dict:
    evidence = patch.get("evidence_ref")
    if not isinstance(evidence, dict):
        raise ValueError("patch missing evidence_ref")
    for key in ("source_id", "revision", "locator"):
        if key not in evidence:
            raise ValueError(f"evidence_ref missing {key}")
    if not isinstance(evidence["source_id"], str) or not evidence["source_id"].strip():
        raise ValueError("evidence_ref.source_id must be non-empty")
    if isinstance(evidence["revision"], bool) or not isinstance(evidence["revision"], (int, str)):
        raise ValueError("evidence_ref.revision must be an integer or string")
    if not isinstance(evidence["locator"], str) or not evidence["locator"].strip():
        raise ValueError("evidence_ref.locator must be non-empty")
    return evidence


def _qualified(dom: minidom.Document, root: minidom.Element, local: str) -> minidom.Element:
    prefix = root.prefix or ""
    return dom.createElementNS(NS_MAIN, f"{prefix}:{local}" if prefix else local)


def _expand_targeted_shared(root, dom, dom_cells, patches, sheet):
    """Materialize only complete shared groups touched by a reviewed patch.

    Translation preserves each member's effective formula. Ambiguous, sparse,
    array, or malformed groups are not guessed. The caller still checks every
    requested cell's exact expected formula before publishing anything.
    """
    cells = {c.get("r"): c for c in root.findall(f".//{{{NS_MAIN}}}c")}
    wanted = set()
    for patch in patches:
        cell = cells.get(patch["cell"])
        f = None if cell is None else cell.find(f"{{{NS_MAIN}}}f")
        if f is not None and f.get("t") == "shared":
            si = f.get("si")
            if si is None or not si.isdecimal():
                raise ValueError(f"invalid shared formula index: {sheet}!{patch['cell']}")
            wanted.add(si)
    if not wanted:
        return []
    from openpyxl.formula.translate import Translator, TranslatorError
    from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries
    expanded = []
    for si in sorted(wanted):
        members = [(ref, c.find(f"{{{NS_MAIN}}}f")) for ref, c in cells.items()
                   if c.find(f"{{{NS_MAIN}}}f") is not None
                   and c.find(f"{{{NS_MAIN}}}f").get("si") == si]
        if any(f.get("t") != "shared" for _, f in members):
            raise ValueError(f"mixed shared formula group: {sheet} index {si}")
        anchors = [(ref, f) for ref, f in members if f.text and f.text.strip()]
        if len(anchors) != 1:
            raise ValueError(f"shared formula anchor missing or ambiguous: {sheet} index {si}")
        anchor, af = anchors[0]
        area = af.get("ref", "")
        if not re.fullmatch(r"[A-Z]+[1-9][0-9]*(?::[A-Z]+[1-9][0-9]*)?", area):
            raise ValueError(f"shared formula anchor range missing or invalid: {sheet}!{anchor}")
        left, top, right, bottom = range_boundaries(area)
        if left > right or top > bottom or right > 16384 or bottom > 1048576:
            raise ValueError(f"invalid shared formula range: {sheet}!{area}")
        if len(members) != (right-left+1)*(bottom-top+1):
            raise ValueError(f"incomplete shared formula group: {sheet}!{area}")
        expression = _normalize_formula(af.text, "shared anchor")
        changes = []
        for ref, f in members:
            row, col = coordinate_to_tuple(ref)
            if not (left <= col <= right and top <= row <= bottom):
                raise ValueError(f"shared formula member outside anchor range: {sheet}!{ref}")
            if ref != anchor and (f.get("ref") is not None or (f.text and f.text.strip())):
                raise ValueError(f"ambiguous shared formula member: {sheet}!{ref}")
            try:
                translated = Translator("=" + expression, origin=anchor).translate_formula(ref)
            except TranslatorError as exc:
                raise ValueError(f"cannot translate shared formula: {sheet}!{ref}") from exc
            resolved = _normalize_formula(translated, "translated shared formula")
            nodes = [n for n in dom_cells[ref].childNodes if n.nodeType == n.ELEMENT_NODE
                     and n.namespaceURI == NS_MAIN and n.localName == "f"]
            if len(nodes) != 1:
                raise ValueError(f"formula node missing or duplicated: {sheet}!{ref}")
            changes.append((ref, f, nodes[0], resolved))
        for ref, f, node, resolved in changes:
            for key in ("t", "ref", "si"):
                f.attrib.pop(key, None)
                if node.hasAttribute(key):
                    node.removeAttribute(key)
            f.text = resolved
            while node.firstChild:
                node.removeChild(node.firstChild)
            node.appendChild(dom.createTextNode(resolved))
            expanded.append({"sheet": sheet, "shared_index": si, "anchor": anchor,
                             "range": area, "cell": ref, "formula": "=" + resolved})
    return expanded


def _patch_copy(source: Path, map_path: Path, out: Path) -> dict:
    if out.exists():
        raise FileExistsError(f"refusing to overwrite output: {out}")
    data = _json(map_path)
    source_info = data.get("source")
    if not isinstance(source_info, dict) or not isinstance(source_info.get("sha256"), str):
        raise ValueError("map must contain source.sha256")
    expected_sha = source_info["sha256"]
    actual_sha = sha256(source)
    if expected_sha != actual_sha:
        raise RuntimeError(f"source version changed: map sha256={expected_sha}, current sha256={actual_sha}")
    patches = _patches(data)
    with zipfile.ZipFile(source, "r") as zin:
        sheets = dict(workbook_sheets(zin))
        by_sheet: dict[str, list[dict]] = {}
        seen: set[tuple[str, str]] = set()
        for patch in patches:
            if not isinstance(patch, dict):
                raise ValueError("patches must be objects")
            sheet, cell_ref = patch.get("sheet"), patch.get("cell")
            if not isinstance(sheet, str) or sheet not in sheets:
                raise ValueError(f"patch references missing sheet: {sheet!r}")
            if not isinstance(cell_ref, str) or not re.fullmatch(r"[A-Za-z]+[1-9][0-9]*", cell_ref.replace("$", "")):
                raise ValueError(f"patch cell must be an exact cell reference: {sheet}!{cell_ref}")
            cell_ref = cell_ref.upper().replace("$", "")
            key = (sheet, cell_ref)
            if key in seen:
                raise ValueError(f"duplicate patch target: {sheet}!{cell_ref}")
            seen.add(key)
            patch = dict(patch)
            patch["cell"] = cell_ref
            has_formula = "expected_formula" in patch
            has_value = "expected_value" in patch
            if has_formula == has_value:
                raise ValueError("patch must contain exactly one of expected_formula or expected_value")
            if has_formula:
                patch["expected_formula"] = _normalize_formula(patch.get("expected_formula"), "expected_formula")
            else:
                patch["expected_value"] = _expected_number(patch.get("expected_value"))
            patch["new_formula"] = _normalize_formula(patch.get("new_formula"), "new_formula")
            if not isinstance(patch.get("reason"), str) or not patch["reason"].strip():
                raise ValueError("patch reason must be non-empty")
            _evidence(patch)
            by_sheet.setdefault(sheet, []).append(patch)

        modified: dict[str, bytes] = {}
        receipt = {
            "schema": "gg-xlsx-formula-patch-receipt/v1",
            "source": {"path": str(source.resolve()), "sha256": actual_sha, "size": source.stat().st_size},
            "map": {"path": str(map_path.resolve()), "sha256": sha256(map_path)},
            "output": {"path": str(out.resolve())},
            "patched": [], "expanded_shared_formulas": [],
            "formulaCachesInvalidated": 0, "recalcNeeded": True,
        }
        for sheet, target in sheets.items():
            raw = zin.read(target)
            root = ET.fromstring(raw)
            dom = _serialize_dom(raw, target)
            dom_cells = {_dom_attr(c, "r"): c for c in _dom_elements(dom, NS_MAIN, "c") if _dom_attr(c, "r")}
            anchors, nonanchors = merged_cells(root)
            receipt["expanded_shared_formulas"].extend(
                _expand_targeted_shared(root, dom, dom_cells, by_sheet.get(sheet, []), sheet))
            for patch in by_sheet.get(sheet, []):
                ref = patch["cell"]
                et_cell = root.find(f".//{{{NS_MAIN}}}c[@r='{ref}']")
                if et_cell is None or ref not in dom_cells:
                    raise ValueError(f"patch references missing cell: {sheet}!{ref}")
                if ref in nonanchors:
                    raise ValueError(f"cannot patch merged non-anchor: {sheet}!{ref}")
                old = _formula_text(et_cell)
                f_et = et_cell.find(f"{{{NS_MAIN}}}f")
                dom_cell = dom_cells[ref]
                if "expected_value" in patch:
                    if old is not None:
                        raise ValueError(f"expected_value target is a formula cell: {sheet}!{ref}")
                    if et_cell.attrib.get("t") not in (None, "n"):
                        raise ValueError(f"expected_value target is not a numeric cell: {sheet}!{ref}")
                    value_node = et_cell.find(f"{{{NS_MAIN}}}v")
                    if value_node is None or value_node.text is None:
                        raise ValueError(f"expected_value target has no numeric value: {sheet}!{ref}")
                    try:
                        actual_decimal = Decimal(value_node.text)
                    except (TypeError, ValueError, InvalidOperation):
                        raise ValueError(f"expected_value target is not numeric: {sheet}!{ref}")
                    if not actual_decimal.is_finite():
                        raise ValueError(f"expected_value target is not finite: {sheet}!{ref}")
                    try:
                        expected_decimal = Decimal(str(patch["expected_value"]))
                    except (InvalidOperation, ValueError):
                        raise ValueError("expected_value must be a finite number")
                    if actual_decimal != expected_decimal:
                        raise ValueError(f"expected value mismatch: {sheet}!{ref}")
                    prefix = dom_cell.prefix or dom.documentElement.prefix or ""
                    formula_node = dom.createElementNS(NS_MAIN, f"{prefix}:f" if prefix else "f")
                    formula_node.appendChild(dom.createTextNode(patch["new_formula"]))
                    value_element = next((c for c in dom_cell.childNodes
                                          if c.nodeType == c.ELEMENT_NODE and c.namespaceURI == NS_MAIN
                                          and c.localName == "v"), None)
                    if value_element is not None:
                        dom_cell.insertBefore(formula_node, value_element)
                    else:
                        dom_cell.appendChild(formula_node)
                    receipt["patched"].append({"sheet": sheet, "cell": ref,
                        "expected_value": patch["expected_value"], "old_value": value_node.text,
                        "old_value_lexeme": value_node.text,
                        "new_formula": patch["new_formula"], "operation": "value_to_formula",
                        "reason": patch["reason"], "evidence_ref": patch["evidence_ref"]})
                else:
                    if old is None:
                        raise ValueError(f"patch target is not a formula cell: {sheet}!{ref}")
                    if f_et is not None and any(k in f_et.attrib for k in ("t", "ref", "si")):
                        raise ValueError(f"shared/array formula target is unsupported: {sheet}!{ref}")
                    if _normalize_formula(old, "existing formula") != patch["expected_formula"]:
                        raise ValueError(f"expected formula mismatch: {sheet}!{ref}")
                    f_nodes = [c for c in dom_cell.childNodes
                               if c.nodeType == c.ELEMENT_NODE and c.namespaceURI == NS_MAIN and c.localName == "f"]
                    if len(f_nodes) != 1:
                        raise ValueError(f"formula node missing or duplicated: {sheet}!{ref}")
                    while f_nodes[0].firstChild:
                        f_nodes[0].removeChild(f_nodes[0].firstChild)
                    f_nodes[0].appendChild(dom.createTextNode(patch["new_formula"]))
                    receipt["patched"].append({"sheet": sheet, "cell": ref,
                        "expected_formula": patch["expected_formula"], "old_formula": "=" + old,
                        "new_formula": patch["new_formula"], "operation": "formula_replace",
                        "reason": patch["reason"], "evidence_ref": patch["evidence_ref"]})
            for cell in dom_cells.values():
                if _dom_invalidate_formula_cache(cell):
                    receipt["formulaCachesInvalidated"] += 1
            modified[target] = dom.toxml(encoding="utf-8")

        try:
            wb_raw = zin.read("xl/workbook.xml")
            wb_dom = _serialize_dom(wb_raw, "xl/workbook.xml")
            calc_nodes = _dom_elements(wb_dom, NS_MAIN, "calcPr")
            calc = calc_nodes[0] if calc_nodes else None
            if calc is None:
                root = wb_dom.documentElement
                calc = _qualified(wb_dom, root, "calcPr")
                ext = next((c for c in root.childNodes if c.nodeType == c.ELEMENT_NODE and c.namespaceURI == NS_MAIN and c.localName == "extLst"), None)
                root.insertBefore(calc, ext) if ext is not None else root.appendChild(calc)
            for key, value in (("calcMode", "auto"), ("fullCalcOnLoad", "1"), ("forceFullCalc", "1")):
                calc.setAttribute(key, value)
            modified["xl/workbook.xml"] = wb_dom.toxml(encoding="utf-8")
        except KeyError:
            raise ValueError("workbook.xml missing; cannot set recalculation flags")

        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                zout.writestr(info, modified.get(info.filename, zin.read(info.filename)))
    receipt["output"].update({"path": str(out.resolve()), "sha256": sha256(out), "size": out.stat().st_size, "status": "patched"})
    return receipt


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args(argv)
    source, out, receipt_path = args.source.resolve(), args.out.resolve(), args.receipt.resolve()
    if len({source, out, receipt_path}) != 3:
        print("BLOCK: source, out, and receipt must be different paths", file=sys.stderr)
        return 2
    staged_out = out.with_name(f".{out.name}.tmp-{os.getpid()}")
    staged_receipt = receipt_path.with_name(f".{receipt_path.name}.tmp-{os.getpid()}")
    try:
        if out.exists() or receipt_path.exists() or staged_out.exists() or staged_receipt.exists():
            raise FileExistsError("refusing to overwrite output, receipt, or staging path")
        out.parent.mkdir(parents=True, exist_ok=True)
        result = _patch_copy(source, args.map.resolve(), staged_out)
        result["output"]["path"] = str(out)
        staged_receipt.parent.mkdir(parents=True, exist_ok=True)
        staged_receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        published = False
        try:
            os.replace(staged_out, out); published = True
            os.replace(staged_receipt, receipt_path)
        except Exception:
            if published and out.exists(): out.unlink()
            raise
        print(json.dumps({"status": "patched", "out": result["output"], "patched": len(result["patched"]),
                          "formulaCachesInvalidated": result["formulaCachesInvalidated"]}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, ET.ParseError) as exc:
        for p in (staged_out, staged_receipt):
            if p.exists(): p.unlink()
        print(f"BLOCK: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
