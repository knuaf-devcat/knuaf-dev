#!/usr/bin/env python3
"""Fill explicitly reviewed cells in an existing XLSX template.

The template is copied as a zip archive and only non-formula cells named by a
write-map are changed.  Worksheet XML is edited through the original
namespace-aware DOM so lexical prefixes, styles, merges and formulas survive.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import zipfile
from pathlib import Path
from xml.dom import minidom

from gg_excel_template import (
    NS_MAIN,
    _dom_attr,
    _dom_elements,
    _dom_invalidate_formula_cache,
    _serialize_dom,
    expand_ref,
    merged_cells,
    sha256,
    text_value,
    workbook_sheets,
    load_shared,
)
from xml.etree import ElementTree as ET
from gg_core import STATES


MAP_SCHEMA = "gg-xlsx-fill-map/v1"
VALUES_SCHEMA = "gg-xlsx-fill-values/v1"
ORIGINS = {"factual", "assumption", "synthetic"}
VALUE_TYPES = {"string", "integer", "number", "boolean", "blank"}
XML_NS = "http://www.w3.org/XML/1998/namespace"
CELL_REF_RE = re.compile(r"^([A-Z]+)([1-9]\d*)$")


def _json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {path}")
    return value


def _template_hash(map_data: dict) -> str:
    template = map_data.get("template")
    if not isinstance(template, dict) or not isinstance(template.get("sha256"), str):
        raise ValueError("map must contain template.sha256")
    return template["sha256"]


def _entries(map_data: dict) -> list[dict]:
    if map_data.get("schema") != MAP_SCHEMA:
        raise ValueError(f"map schema must be {MAP_SCHEMA}")
    entries = map_data.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("map must contain non-empty entries")
    return entries


def _values(values_data: dict) -> list[dict]:
    if values_data.get("schema") != VALUES_SCHEMA:
        raise ValueError(f"values schema must be {VALUES_SCHEMA}")
    values = values_data.get("values")
    if not isinstance(values, list):
        raise ValueError("values must contain a list")
    return values


def _evidence(value: dict) -> dict:
    evidence = value.get("evidence_ref")
    if not isinstance(evidence, dict):
        raise ValueError("value missing evidence_ref")
    for key in ("source_id", "revision", "locator", "origin"):
        if key not in evidence:
            raise ValueError(f"evidence_ref missing {key}")
    if not isinstance(evidence["source_id"], str) or not evidence["source_id"].strip():
        raise ValueError("evidence_ref.source_id must be non-empty")
    if not isinstance(evidence["revision"], (int, str)) or isinstance(evidence["revision"], bool):
        raise ValueError("evidence_ref.revision must be an integer or revision string")
    if not isinstance(evidence["locator"], str) or not evidence["locator"].strip():
        raise ValueError("evidence_ref.locator must be non-empty")
    if evidence["origin"] not in ORIGINS:
        raise ValueError(f"evidence_ref.origin must be one of {sorted(ORIGINS)}")
    return evidence


def _typed_value(value: dict) -> tuple[str, object]:
    if "value_type" not in value or "value" not in value:
        raise ValueError("value must contain value and value_type")
    value_type = value["value_type"]
    if value_type not in VALUE_TYPES:
        raise ValueError(f"unsupported value_type: {value_type!r}")
    raw = value["value"]
    if "answer_state" not in value:
        raise ValueError("value must contain answer_state")
    if value["answer_state"] not in STATES:
        raise ValueError("unsupported answer_state")
    if value["answer_state"] != "provided" and value_type != "blank":
        raise ValueError("unresolved/none answers cannot be converted to cell values")
    if value_type == "blank":
        if raw is not None:
            raise ValueError("blank value_type requires value=null")
    elif value_type == "string" and not isinstance(raw, str):
        raise ValueError("string value_type requires a string")
    elif value_type == "integer" and (not isinstance(raw, int) or isinstance(raw, bool)):
        raise ValueError("integer value_type requires an integer")
    elif value_type == "number" and (not isinstance(raw, (int, float)) or isinstance(raw, bool)):
        raise ValueError("number value_type requires a JSON number")
    elif value_type == "number" and isinstance(raw, float) and not math.isfinite(raw):
        raise ValueError("number value_type must be finite")
    elif value_type == "boolean" and not isinstance(raw, bool):
        raise ValueError("boolean value_type requires a boolean")
    return value_type, raw


def _cell_value_node(cell: minidom.Element, name: str) -> minidom.Element:
    prefix = cell.prefix or ""
    qualified = f"{prefix}:{name}" if prefix else name
    return cell.ownerDocument.createElementNS(NS_MAIN, qualified)


def _remove_cell_values(cell: minidom.Element) -> None:
    for child in list(cell.childNodes):
        if child.nodeType == child.ELEMENT_NODE and child.namespaceURI == NS_MAIN and child.localName in {"v", "is"}:
            cell.removeChild(child)


def _set_cell_value(cell: minidom.Element, value_type: str, raw: object) -> None:
    _remove_cell_values(cell)
    if value_type == "blank":
        if cell.hasAttribute("t"):
            cell.removeAttribute("t")
        return
    if value_type == "string":
        cell.setAttribute("t", "inlineStr")
        is_node = _cell_value_node(cell, "is")
        text = _cell_value_node(cell, "t")
        if str(raw)[:1].isspace() or str(raw)[-1:].isspace():
            text.setAttributeNS(XML_NS, "xml:space", "preserve")
        text.appendChild(cell.ownerDocument.createTextNode(str(raw)))
        is_node.appendChild(text)
        cell.appendChild(is_node)
        return
    if value_type == "boolean":
        cell.setAttribute("t", "b")
        lexical = "1" if raw else "0"
    else:
        if cell.hasAttribute("t"):
            cell.removeAttribute("t")
        lexical = str(raw)
    value_node = _cell_value_node(cell, "v")
    value_node.appendChild(cell.ownerDocument.createTextNode(lexical))
    cell.appendChild(value_node)


def _coordinate(ref: str) -> tuple[int, int]:
    match = CELL_REF_RE.fullmatch(ref)
    if not match:
        raise ValueError(f"invalid cell reference: {ref}")
    column = 0
    for char in match.group(1):
        column = column * 26 + ord(char) - ord("A") + 1
    return int(match.group(2)), column


def _element(document: minidom.Document, parent: minidom.Element, name: str) -> minidom.Element:
    prefix = parent.prefix or ""
    return document.createElementNS(NS_MAIN, f"{prefix}:{name}" if prefix else name)


def _create_blank_cell(dom: minidom.Document, root: minidom.Element, ref: str) -> minidom.Element:
    """Create a new blank cell only for a reviewed below-table provenance note."""
    row_number, column_number = _coordinate(ref)
    sheet_data = next(
        (node for node in root.childNodes if node.nodeType == node.ELEMENT_NODE
         and node.namespaceURI == NS_MAIN and node.localName == "sheetData"),
        None,
    )
    if sheet_data is None:
        raise ValueError("worksheet missing sheetData")
    rows = [
        node for node in sheet_data.childNodes if node.nodeType == node.ELEMENT_NODE
        and node.namespaceURI == NS_MAIN and node.localName == "row"
    ]
    row = next((node for node in rows if node.getAttribute("r") == str(row_number)), None)
    if row is None:
        row = _element(dom, root, "row")
        row.setAttribute("r", str(row_number))
        later = next((node for node in rows if int(node.getAttribute("r")) > row_number), None)
        sheet_data.insertBefore(row, later) if later else sheet_data.appendChild(row)
    cell = _element(dom, root, "c")
    cell.setAttribute("r", ref)
    cells = [
        node for node in row.childNodes if node.nodeType == node.ELEMENT_NODE
        and node.namespaceURI == NS_MAIN and node.localName == "c"
    ]
    later = next((node for node in cells if _coordinate(node.getAttribute("r"))[1] > column_number), None)
    row.insertBefore(cell, later) if later else row.appendChild(cell)
    return cell


def _prepare(template: Path, map_path: Path, values_path: Path):
    map_data = _json(map_path)
    values_data = _json(values_path)
    expected = _template_hash(map_data)
    actual = sha256(template)
    if expected != actual:
        raise RuntimeError(f"template version changed: map sha256={expected}, current sha256={actual}")
    entries = _entries(map_data)
    values = _values(values_data)
    return map_data, values_data, entries, values, actual


def fill_copy(template: Path, map_path: Path, values_path: Path, out: Path) -> dict:
    if out.exists():
        raise FileExistsError(f"refusing to overwrite output: {out}")
    map_data, values_data, entries, values, template_digest = _prepare(template, map_path, values_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(template, "r") as zin:
        sheets = dict(workbook_sheets(zin))
        shared = load_shared(zin)
        map_cells: dict[tuple[str, str], dict] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("map entries must be objects")
            sheet = entry.get("sheet")
            refs = entry.get("range") or entry.get("cell")
            if not isinstance(sheet, str) or sheet not in sheets:
                raise ValueError(f"map references missing sheet: {sheet!r}")
            if not isinstance(refs, str) or not refs:
                raise ValueError("map entry missing range/cell")
            if not isinstance(entry.get("role"), str) or not entry["role"].strip():
                raise ValueError("map entry role must be non-empty")
            if "period" not in entry:
                raise ValueError("map entry missing period")
            if "semanticField" in entry:
                if any(
                    not isinstance(entry.get(field), str) or not entry[field].strip()
                    for field in ("semanticField", "unit")
                ) or entry["period"] is None:
                    raise ValueError("semantic map requires meaning, unit and period")
            if not isinstance(entry.get("source_note"), str) or not entry["source_note"].strip():
                raise ValueError("map entry source_note must be non-empty")
            if "editable" not in entry or entry["editable"] is not True:
                raise ValueError("map entry editable must be explicitly true")
            if "create_if_missing" in entry:
                if entry["create_if_missing"] is not True:
                    raise ValueError("create_if_missing must be explicitly true")
                if entry["role"] != "notes.provenance" or entry.get("range"):
                    raise ValueError("only one provenance-note cell may be created")
            for ref in expand_ref(refs):
                key = (sheet, ref)
                if key in map_cells:
                    raise ValueError(f"duplicate or overlapping map cell: {sheet}!{ref}")
                map_cells[key] = entry

        value_cells: dict[tuple[str, str], dict] = {}
        for value in values:
            if not isinstance(value, dict):
                raise ValueError("values entries must be objects")
            sheet, ref = value.get("sheet"), value.get("cell")
            if not isinstance(sheet, str) or sheet not in sheets:
                raise ValueError(f"value references missing sheet: {sheet!r}")
            if not isinstance(ref, str) or not ref:
                raise ValueError("value entry missing sheet/cell")
            refs = expand_ref(ref)
            if len(refs) != 1 or refs[0] != ref.upper().replace("$", ""):
                raise ValueError(f"value cell must be one exact cell reference: {sheet}!{ref}")
            key = (sheet, refs[0])
            if key in value_cells:
                raise ValueError(f"duplicate value write: {sheet}!{refs[0]}")
            if key not in map_cells:
                raise ValueError(f"value outside write-map: {sheet}!{refs[0]}")
            if "semanticField" in map_cells[key] or "semanticField" in value:
                if any(
                    field not in value
                    or field not in map_cells[key]
                    or value[field] != map_cells[key][field]
                    for field in ("semanticField", "unit", "period")
                ):
                    raise ValueError(f"semantic input mismatch: {sheet}!{refs[0]}")
            _typed_value(value)
            _evidence(value)
            value_cells[key] = value

        modified: dict[str, bytes] = {}
        receipt = {
            "schema": "gg-xlsx-fill-receipt/v1",
            "template": {"path": str(template.resolve()), "sha256": template_digest, "size": template.stat().st_size},
            "map": {"path": str(map_path.resolve()), "sha256": sha256(map_path)},
            "values": {"path": str(values_path.resolve()), "sha256": sha256(values_path)},
            "output": {"path": str(out.resolve())},
            "written": [], "mappedCells": len(map_cells), "omittedMappedCells": 0,
            "formulaCellsProtected": 0, "mergedCellsProtected": 0,
            "formulaCachesInvalidated": 0, "recalcNeeded": True, "errors": [],
        }
        for sheet, target in sheets.items():
            raw = zin.read(target)
            root = ET.fromstring(raw)
            dom = _serialize_dom(raw, target)
            dom_cells = {_dom_attr(c, "r"): c for c in _dom_elements(dom, NS_MAIN, "c") if _dom_attr(c, "r")}
            anchors, nonanchors = merged_cells(root)
            # Validate the complete write-map against this worksheet before any
            # mutation. This catches omitted writes that otherwise could hide an
            # unknown cell, formula target, or merged non-anchor.
            for (mapped_sheet, ref), mapped_entry in map_cells.items():
                if mapped_sheet != sheet:
                    continue
                if ref not in dom_cells:
                    if not mapped_entry.get("create_if_missing") or (sheet, ref) not in value_cells:
                        raise ValueError(f"map references missing cell: {sheet}!{ref}")
                    value_type, _ = _typed_value(value_cells[(sheet, ref)])
                    if value_type != "string" or ref in anchors or ref in nonanchors:
                        raise ValueError(f"cannot create non-string or merged cell: {sheet}!{ref}")
                    dom_cells[ref] = _create_blank_cell(dom, dom.documentElement, ref)
                if ref in nonanchors:
                    raise ValueError(f"map references merged non-anchor: {sheet}!{ref}")
                if root.find(f".//{{{NS_MAIN}}}c[@r='{ref}']/{{{NS_MAIN}}}f") is not None:
                    raise ValueError(f"map references formula cell: {sheet}!{ref}")
            for ref, cell in dom_cells.items():
                if _dom_invalidate_formula_cache(cell):
                    receipt["formulaCachesInvalidated"] += 1
            for (target_sheet, ref), value in value_cells.items():
                if target_sheet != sheet:
                    continue
                if ref not in dom_cells:
                    raise ValueError(f"value references missing cell: {sheet}!{ref}")
                if ref in nonanchors:
                    receipt["mergedCellsProtected"] += 1
                    raise ValueError(f"cannot write merged non-anchor: {sheet}!{ref}")
                et_cell = root.find(f".//{{{NS_MAIN}}}c[@r='{ref}']")
                created_note = map_cells[(sheet, ref)].get("create_if_missing") is True
                if et_cell is None and not created_note:
                    raise ValueError(f"value references missing cell: {sheet}!{ref}")
                if et_cell is not None and et_cell.find(f"{{{NS_MAIN}}}f") is not None:
                    raise ValueError(f"cannot overwrite formula cell: {sheet}!{ref}")
                old = text_value(et_cell, shared) if et_cell is not None else None
                value_type, raw_value = _typed_value(value)
                _set_cell_value(dom_cells[ref], value_type, raw_value)
                receipt["written"].append({
                    "sheet": sheet, "cell": ref, "oldValue": old,
                    "newValue": raw_value, "valueType": value_type,
                    "role": map_cells[(sheet, ref)]["role"],
                    "period": map_cells[(sheet, ref)]["period"],
                    "source_note": map_cells[(sheet, ref)]["source_note"],
                    "evidence_ref": value["evidence_ref"],
                    "answer_state": value["answer_state"],
                })
            modified[target] = dom.toxml(encoding="utf-8")
        receipt["omittedMappedCells"] = len(map_cells) - len(value_cells)
        try:
            wb_raw = zin.read("xl/workbook.xml")
            wb_dom = _serialize_dom(wb_raw, "xl/workbook.xml")
            calc_nodes = _dom_elements(wb_dom, NS_MAIN, "calcPr")
            calc = calc_nodes[0] if calc_nodes else None
            if not calc_nodes:
                # workbook.xml may use a lexical prefix (for example x:workbook).
                # Reuse it for calcPr and place the node before extLst, which
                # must remain the final workbook child in SpreadsheetML.
                root_prefix = wb_dom.documentElement.prefix or ""
                qualified = f"{root_prefix}:calcPr" if root_prefix else "calcPr"
                calc = wb_dom.createElementNS(NS_MAIN, qualified)
                ext = next((c for c in wb_dom.documentElement.childNodes
                            if c.nodeType == c.ELEMENT_NODE and c.namespaceURI == NS_MAIN and c.localName == "extLst"), None)
                if ext is None:
                    wb_dom.documentElement.appendChild(calc)
                else:
                    wb_dom.documentElement.insertBefore(calc, ext)
            for key, value in (("calcMode", "auto"), ("fullCalcOnLoad", "1"), ("forceFullCalc", "1")):
                calc.setAttribute(key, value)
            modified["xl/workbook.xml"] = wb_dom.toxml(encoding="utf-8")
        except KeyError:
            receipt["errors"].append("workbook.xml missing; calculation mode not updated")
        try:
            with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                for info in zin.infolist():
                    zout.writestr(info, modified.get(info.filename, zin.read(info.filename)))
        except Exception:
            if out.exists():
                out.unlink()
            raise
    receipt["output"].update({"sha256": sha256(out), "size": out.stat().st_size, "status": "filled"})
    return receipt


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--values", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    if args.receipt is not None and args.out.resolve() == args.receipt.resolve():
        print("BLOCK: --out and --receipt must be different paths", file=sys.stderr)
        return 2
    staged_out = args.out.with_name(f".{args.out.name}.tmp-{os.getpid()}")
    staged_receipt = args.receipt.with_name(f".{args.receipt.name}.tmp-{os.getpid()}") if args.receipt else None
    try:
        if args.out.exists() or (args.receipt and args.receipt.exists()):
            raise FileExistsError("refusing to overwrite output or receipt")
        if staged_out.exists() or (staged_receipt and staged_receipt.exists()):
            raise FileExistsError("staging path already exists")
        receipt = fill_copy(args.template.resolve(), args.map.resolve(), args.values.resolve(), staged_out)
        receipt["output"]["path"] = str(args.out.resolve())
        if staged_receipt:
            staged_receipt.parent.mkdir(parents=True, exist_ok=True)
            staged_receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        published = False
        try:
            os.replace(staged_out, args.out)
            published = True
            if staged_receipt:
                os.replace(staged_receipt, args.receipt)
        except Exception:
            if published and args.out.exists():
                args.out.unlink()
            raise
        print(json.dumps({"status": "filled", "out": receipt["output"], "written": len(receipt["written"]),
                          "formulaCachesInvalidated": receipt["formulaCachesInvalidated"]}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, ET.ParseError) as exc:
        for pending in (staged_out, staged_receipt):
            if pending and pending.exists():
                pending.unlink()
        print(f"BLOCK: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
