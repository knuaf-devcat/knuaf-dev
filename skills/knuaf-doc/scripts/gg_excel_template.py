#!/usr/bin/env python3
"""Source-bound reusable XLSX template inspection and blank-copy utility.

The utility edits worksheet XML in a zip-preserving pass. This keeps styles,
drawings, merges, links, print settings and formula expressions intact while
removing only cells listed in an explicit, SHA-bound input map. Formula cached
values are invalidated in the output so a blank template never presents old
calculated results as current financial results.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import zipfile
import unicodedata
from xml.dom import minidom
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
ET.register_namespace("", NS_MAIN)

CELL_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*)$")
RANGE_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*)(?::([A-Z]+)([1-9][0-9]*))?$")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_source(path: Path) -> Path:
    """Resolve a user-supplied NFC/NFD path without guessing another workbook."""
    if path.exists():
        return path
    parent = path.parent
    wanted = unicodedata.normalize("NFD", path.name)
    matches = [p for p in parent.glob("*.xlsx") if unicodedata.normalize("NFD", p.name) == wanted]
    if len(matches) == 1:
        return matches[0]
    raise FileNotFoundError(f"source workbook not found (NFC/NFD exact match failed): {path}")


def col_num(col: str) -> int:
    n = 0
    for c in col:
        n = n * 26 + ord(c) - 64
    return n


def col_name(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


MAX_EXPAND_REF_CELLS = 16384
MAX_MERGED_TOTAL_CELLS = 262144
EXCEL_MAX_COL = 16384  # XFD
EXCEL_MAX_ROW = 1048576


def expand_ref(ref: str) -> list[str]:
    m = RANGE_RE.match(ref.upper().replace("$", ""))
    if not m:
        raise ValueError(f"invalid cell/range reference: {ref}")
    c1, r1, c2, r2 = m.group(1), int(m.group(2)), m.group(3), m.group(4)
    c2, r2 = c2 or c1, int(r2 or r1)
    lo_c, hi_c = min(col_num(c1), col_num(c2)), max(col_num(c1), col_num(c2))
    lo_r, hi_r = min(r1, r2), max(r1, r2)
    if hi_c > EXCEL_MAX_COL or hi_r > EXCEL_MAX_ROW:
        raise ValueError(f"cell/range reference outside Excel bounds: {ref}")
    n = (hi_r - lo_r + 1) * (hi_c - lo_c + 1)
    if n > MAX_EXPAND_REF_CELLS:
        raise ValueError(f"cell range too large to expand: {ref} ({n} cells)")
    return [f"{col_name(c)}{r}" for r in range(lo_r, hi_r + 1)
            for c in range(lo_c, hi_c + 1)]


def local(tag: str) -> str:
    return f"{{{NS_MAIN}}}{tag}"


def is_reference_text(value: str) -> bool:
    """Detect narrative/reference text that is not a fixed worksheet label."""
    if value.startswith("*"):
        return True
    markers = ("강원도", "원주시", "농촌진흥청", "임산물", "소득조사", "유통정보",
               "물가상승률", "택배", "일당 기준", "판매량", "판매가격", "3년생", "2,000",
               "60,000", "경제성분석", "기준으로 작성", "`", "주소")
    return len(value) > 24 and any(m in value for m in markers)


def text_value(cell: ET.Element, shared: list[str]) -> str | int | float | None:
    t = cell.attrib.get("t")
    if t == "inlineStr":
        return "".join(cell.itertext())
    v = cell.find(local("v"))
    if v is None:
        return None
    raw = v.text or ""
    if t == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return raw
    if t == "b":
        return raw == "1"
    try:
        return float(raw) if any(x in raw for x in ".eE") else int(raw)
    except ValueError:
        return raw


def load_shared(z: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(si.itertext()) for si in root.findall(local("si"))]


def workbook_sheets(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
    out = []
    for s in wb.findall(f"{{{NS_MAIN}}}sheets/{{{NS_MAIN}}}sheet"):
        rid = s.attrib.get(f"{{{NS_REL}}}id")
        target = rid_to_target.get(rid, "")
        if target.startswith("/"):
            target = target[1:]
        elif not target.startswith("xl/"):
            target = "xl/" + target
        out.append((s.attrib["name"], target))
    return out


def merged_cells(root: ET.Element) -> tuple[set[str], set[str]]:
    anchors, nonanchors = set(), set()
    mc = root.find(local("mergeCells"))
    if mc is None:
        return anchors, nonanchors
    for m in mc.findall(local("mergeCell")):
        ref = m.attrib.get("ref", "")
        cells = expand_ref(ref)
        if cells:
            anchors.add(cells[0])
            nonanchors.update(cells[1:])
        if len(anchors) + len(nonanchors) > MAX_MERGED_TOTAL_CELLS:
            raise ValueError("merged cell ranges exceed safety bound")
    return anchors, nonanchors


def inspect_source(source: Path, out_map: Path | None, report: Path | None,
                   legacy_map: bool = False) -> dict:
    source = resolve_source(source).resolve()
    if out_map and out_map.exists():
        raise FileExistsError(f"refusing to overwrite map: {out_map}")
    if report and report.exists():
        raise FileExistsError(f"refusing to overwrite report: {report}")
    digest = sha256(source)
    with zipfile.ZipFile(source) as z:
        shared = load_shared(z)
        sheets = workbook_sheets(z)
        inventory = []
        sheet_summaries = []
        nonanchors_by_sheet: dict[str, set[str]] = {}
        for idx, (name, target) in enumerate(sheets):
            root = ET.fromstring(z.read(target))
            _, nonanchors_by_sheet[name] = merged_cells(root)
            cells = []
            formulas = 0
            for c in root.findall(f".//{local('c')}"):
                ref = c.attrib.get("r")
                if not ref:
                    continue
                f = c.find(local("f"))
                if f is not None:
                    formulas += 1
                cells.append({"cell": ref, "value": text_value(c, shared),
                              "formula": f.text if f is not None else None,
                              "style": c.attrib.get("s")})
            sheet_summaries.append({"name": name, "index": idx, "xml": target,
                                    "cellCount": len(cells), "formulaCount": formulas})
            inventory.extend({"sheet": name, **c} for c in cells)
    sheet_names = {name for name, _ in sheets}
    if legacy_map:
        entries = default_entries(inventory)
        missing_sheets = sorted({ent["sheet"] for ent in entries} - sheet_names)
        if missing_sheets:
            raise ValueError("map references missing sheet: " + ", ".join(missing_sheets))
        entries_source = "legacy"
    else:
        entries = inventory_entries(inventory, nonanchors_by_sheet)
        entries_source = "inventory"
    result = {
        "schema": "gg-xlsx-template-map/v1",
        "entriesSource": entries_source,
        "source": {"path": str(source), "sha256": digest, "size": source.stat().st_size},
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sheets": sheet_summaries,
        "entries": entries,
        "inventory": inventory,
        "policy": {
            "clearOnlyListed": True,
            "protectFormulas": True,
            "protectMergedNonAnchors": True,
            "invalidateFormulaCaches": True,
            "sourceVersionFailClosed": True,
            "noOverwrite": True,
            "legacyErrorsPreserved": True,
            "unclassifiedTextDisclosed": True,
            "publicationReady": False,
            "referenceSheetPreserved": "참고1. 모델농장분석" if legacy_map else None,
        },
    }
    if out_map:
        out_map.parent.mkdir(parents=True, exist_ok=True)
        out_map.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps({k: result[k] for k in ("schema", "source", "sheets", "entries", "policy")},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def e(sheet: str, refs: str, semantic: str, reason: str, action: str = "clear") -> dict:
    return {"sheet": sheet, "range": refs, "semanticField": semantic, "reason": reason,
            "action": action, "explicit": True}


LABEL_TEXT_RE = re.compile(r"^[가-힣ㄱ-ㅎㅏ-ㅣ\s()（）\[\]/·,.\-]+$")
MAX_LABEL_TEXT_LEN = 24


def is_label_text(value: str, ref: str) -> bool:
    """Heuristic: fixed worksheet label rather than a sample input value."""
    text = value.strip()
    if not text:
        return False
    if text.endswith((":", "：")):
        return True
    m = CELL_RE.match(ref)
    if m and m.group(1) == "A":
        return True
    return len(text) <= MAX_LABEL_TEXT_LEN and bool(LABEL_TEXT_RE.match(text))


def inventory_entries(inventory: list[dict], nonanchors_by_sheet: dict[str, set[str]] | None = None) -> list[dict]:
    """Derive one explicit entry per literal cell from the inspected inventory.

    Formula cells and merged non-anchor cells are skipped. Numbers and ordinary
    text become ``input_candidate`` clear entries; label-like text (ends with a
    colon, sits in column A, or is a short all-Korean header) and narrative
    reference text are recorded as ``preserve`` entries so the map stays explicit.
    """
    nonanchors_by_sheet = nonanchors_by_sheet or {}
    out = []
    for item in inventory:
        if item.get("formula") is not None:
            continue
        sheet, ref, value = item["sheet"], item["cell"], item.get("value")
        if value is None or ref in nonanchors_by_sheet.get(sheet, set()):
            continue
        if isinstance(value, str):
            if not value.strip():
                continue
            if is_label_text(value, ref):
                out.append({"sheet": sheet, "range": ref, "semanticField": "label", "role": "label",
                            "reason": "label-like text in source workbook", "action": "preserve",
                            "explicit": True})
                continue
            if is_reference_text(value):
                out.append({"sheet": sheet, "range": ref, "semanticField": "reference_text",
                            "role": "reference_text", "reason": "reference/narrative text in source workbook",
                            "action": "preserve", "explicit": True})
                continue
        elif not isinstance(value, (bool, int, float)):
            continue
        out.append({"sheet": sheet, "range": ref, "semanticField": "input_candidate",
                    "role": "input_candidate", "reason": "literal value in source workbook",
                    "action": "clear", "explicit": True})
    return out


def default_entries(inventory: list[dict]) -> list[dict]:
    """Return the legacy explicit cell map for the original 17-sheet school workbook.

    The inventory argument is unused: this map is hard-coded and only valid
    behind ``inspect --legacy-map``, which verifies every referenced sheet exists.
    """
    out = [
        e("1. 기초재무상태조사", "B9:F9", "existing_land_asset", "sample author's land facts"),
        e("1. 기초재무상태조사", "H9", "existing_land_asset_note", "sample author's land note"),
        e("1. 기초재무상태조사", "C39", "cash_account_name", "sample cash account"),
        e("1. 기초재무상태조사", "E39", "cash_and_equivalents", "sample cash balance"),
        e("3.투자계획", "B8:C8", "investment_summary_inputs", "sample first-year investment summary"),
        e("3.투자계획", "E8", "investment_summary_subsidy", "sample first-year subsidy input"),
        e("3.투자계획", "B19:D23", "annual_investment_plan", "sample investment detail facts"),
        e("3.투자계획", "E20:E23", "annual_investment_amounts", "sample investment amounts"),
        e("3.투자계획", "F19:H23", "annual_investment_funding", "sample funding sources"),
        e("3.투자계획", "I20:I22", "annual_investment_notes", "sample investment notes"),
        e("3.투자계획", "G28:H28", "annual_investment_funding_later", "sample later-year funding"),
        e("3.투자계획", "G25:H27", "annual_investment_funding_later", "sample later-year funding"),
        e("4. 원리금상환계획", "B38:C38", "loan_terms", "sample loan product and timing"),
        e("4. 원리금상환계획", "E38:F38", "loan_terms", "sample loan condition and rate"),
        e(" 5. 판매계획", "D22:L24", "sales_channel_mix", "sample procurement channel percentages"),
        e(" 5. 판매계획", "D26:L28", "sales_channel_mix", "sample direct channel percentages"),
        e(" 5. 판매계획", "D30", "sales_channel_mix_residual", "sample residual channel percentage"),
        e("6. 생산계획", "H8:T8", "production_area", "sample cultivation area inputs"),
        e("6. 생산계획", "H9:T9", "production_output", "sample production output inputs"),
        e("6. 생산계획", "H15:H17", "production_basis_notes", "sample production basis narrative"),
        e("6. 생산계획", "H19:H24", "production_basis_notes", "sample production basis narrative"),
        e("6. 생산계획", "H25:H28", "production_basis_notes", "sample production basis narrative"),
        e("6. 생산계획", "E38", "legacy_note_artifact", "stray sample note artifact"),
        e("7. 영농자재소요계획", "D15:E15", "annual_material_area_basis", "sample first-year area basis"),
        e("7. 영농자재소요계획", "C19", "annual_material_other_cost", "sample first-year other material cost"),
        e("7. 영농자재소요계획", "G19", "annual_material_other_amount", "sample first-year other amount"),
        e("7. 영농자재소요계획", "D25:E25", "annual_material_area_basis", "sample second-year area basis"),
        e("7. 영농자재소요계획", "C29", "annual_material_other_cost", "sample second-year other material cost"),
        e("7. 영농자재소요계획", "G29", "annual_material_other_amount", "sample second-year other amount"),
        e("7. 영농자재소요계획", "D35:E35", "annual_material_area_basis", "sample third-year area basis"),
        e("7. 영농자재소요계획", "C39", "annual_material_other_cost", "sample third-year other material cost"),
        e("7. 영농자재소요계획", "G39", "annual_material_other_amount", "sample third-year other amount"),
        e("7. 영농자재소요계획", "D45:E45", "annual_material_area_basis", "sample fourth-year area basis"),
        e("7. 영농자재소요계획", "C49", "annual_material_other_cost", "sample fourth-year other material cost"),
        e("7. 영농자재소요계획", "G49", "annual_material_other_amount", "sample fourth-year other amount"),
        e("7. 영농자재소요계획", "D55:E55", "annual_material_area_basis", "sample fifth-year area basis"),
        e("7. 영농자재소요계획", "C59", "annual_material_other_cost", "sample fifth-year other material cost"),
        e("7. 영농자재소요계획", "G59", "annual_material_other_amount", "sample fifth-year other amount"),
        e("8. 노무비계획", "G8:J8", "self_labor_days", "sample self-labor workdays"),
        e("8. 노무비계획", "F11:G12", "hired_labor_rates_days", "sample hired-labor rates and days"),
        e("8. 노무비계획", "J11:S12", "hired_labor_days", "sample hired-labor workdays"),
        e("8. 노무비계획", "I26:K30", "labor_detail_self_days", "sample first-year labor detail days"),
        e("8. 노무비계획", "O26:S30", "labor_detail_hired_days", "sample first-year hired detail days"),
        e("8. 노무비계획", "I37:K41", "labor_detail_self_days", "sample later-year labor detail days"),
        e("8. 노무비계획", "O37:S41", "labor_detail_hired_days", "sample later-year hired detail days"),
        e("8. 노무비계획", "B17:B20", "labor_basis_notes", "sample wage and workday assumptions"),
        e("9 .경비계획", "D5:D10", "expense_assumptions", "sample expense rates and areas"),
        e("9 .경비계획", "C23", "biological_asset_expense", "sample zero biological-asset expense"),
        e("9 .경비계획", "C43", "biological_asset_expense", "sample zero biological-asset expense"),
        e("9 .경비계획", "C49", "other_expense", "sample zero other expense"),
        e("9 .경비계획", "C63", "biological_asset_expense", "sample zero biological-asset expense"),
        e("9 .경비계획", "C69", "other_expense", "sample zero other expense"),
        e("9 .경비계획", "C83", "biological_asset_expense", "sample zero biological-asset expense"),
        e("9 .경비계획", "C89", "other_expense", "sample zero other expense"),
        e("9 .경비계획", "C103", "biological_asset_expense", "sample zero biological-asset expense"),
        e("9 .경비계획", "C109", "other_expense", "sample zero other expense"),
        e("10. 감가상각비계획 ", "C9:D10", "depreciation_assumptions", "sample facility assumptions"),
        e("10. 감가상각비계획 ", "F9:H10", "depreciation_assumptions", "sample machinery assumptions"),
        e("10. 감가상각비계획 ", "C11:H11", "depreciation_years_used", "sample asset years used"),
        e("11. 생산원가계획", "C24:G24", "biological_asset_cost", "sample zero biological-asset cost"),
        e("11. 생산원가계획", "C28:G28", "contract_farming_cost", "sample zero contract-farming cost"),
        e("12 손익계획", "E30:E33", "packaging_cost_inputs", "sample packaging inputs"),
        e("12 손익계획", "C35:G35", "packaging_production_quantity", "sample packaging quantity inputs"),
        e("12 손익계획", "B38", "packaging_note", "sample packaging calculation narrative"),
        e("14. 현금흐름계획", "E15:E16", "later_year_investment_cashflow", "sample later-year investment cashflow"),
        e("14. 현금흐름계획", "D17", "perennial_investment_cashflow", "sample perennial investment cashflow"),
        # This sheet is an example-only reference and is deliberately retained.
        e("참고1. 모델농장분석", "A1:E19", "reference_model_farm", "example-only reference sheet; retain verbatim", "preserve"),
    ]

    # Hard-coded legacy outputs and public benchmark tables are retained and
    # explicitly classified so they cannot be mistaken for missing input cells.
    preserve = [
        ("2. 중장기영농목표", "C12", "zero-denominator guard; derived output stored as a legacy constant"),
        ("3.투자계획", "F9:F12", "summary financing zeros; legacy derived constants"),
        ("3.투자계획", "B12:F12", "year-5 summary row; legacy structure/constants"),
        ("4. 원리금상환계획", "B10:F32", "repayment schedule outputs; legacy constants without formulas"),
        ("4. 원리금상환계획", "B44:F66", "loan detail schedule outputs; legacy constants without formulas"),
        (" 5. 판매계획", "M6:M11", "public benchmark years/prices; example reference data"),
        (" 5. 판매계획", "E7:M13", "public benchmark price history; example reference data"),
        (" 5. 판매계획", "D25:M25", "channel totals; legacy constants"),
        (" 5. 판매계획", "D29:M29", "channel totals; legacy constants"),
        (" 5. 판매계획", "D31:M31", "channel totals; legacy constants"),
        (" 5. 판매계획", "C43:K43", "sales output row; formula/cache legacy constants"),
        ("8. 노무비계획", "W7:Y19", "public wage benchmark/projection table; legacy constants"),
        ("8. 노무비계획", "U28:U41", "labor detail totals; legacy constants"),
        ("8. 노무비계획", "G13", "labor subtotal zero; legacy constant"),
        ("8. 노무비계획", "P13", "labor subtotal zero; legacy constant"),
        ("10. 감가상각비계획 ", "H20:H22", "later-year asset assumptions copied from year one; legacy constants"),
        ("10. 감가상각비계획 ", "G23:H23", "later-year usage years; derived constants"),
        ("10. 감가상각비계획 ", "H32:H34", "later-year asset assumptions copied from year one; legacy constants"),
        ("10. 감가상각비계획 ", "G35:H35", "later-year usage years; derived constants"),
        ("10. 감가상각비계획 ", "H44:H46", "later-year asset assumptions copied from year one; legacy constants"),
        ("10. 감가상각비계획 ", "G47:H47", "later-year usage years; derived constants"),
        ("10. 감가상각비계획 ", "H56:H58", "later-year asset assumptions copied from year one; legacy constants"),
        ("10. 감가상각비계획 ", "G59:H59", "later-year usage years; derived constants"),
        ("11. 생산원가계획", "E5:G5", "production cost outputs; legacy constants"),
        ("12 손익계획", "C11:G13", "selling/admin outputs; legacy constants"),
        ("13. 추정대차대조표", "D15:H15", "balance-sheet outputs; legacy constants"),
        ("13. 추정대차대조표", "D26:H32", "balance-sheet outputs; legacy constants"),
        ("15.추정소득분석", "G26:I28", "income analysis outputs; legacy constants"),
        ("15.추정소득분석", "G31:I32", "income analysis outputs; legacy constants"),
        ("15.추정소득분석", "E28", "zero-denominator guard; derived output stored as a legacy constant"),
        ("15.추정소득분석", "E32", "zero-denominator guard; derived output stored as a legacy constant"),
        (" 5. 판매계획", "B14:B15", "public benchmark source notes; fixed reference text"),
        (" 5. 판매계획", "B32", "public distribution source note; fixed reference text"),
        (" 5. 판매계획", "B45:B46", "pricing and channel method notes; fixed reference text"),
        ("7. 영농자재소요계획", "G5", "public cost-survey source note; fixed reference text"),
        ("7. 영농자재소요계획", "C6:C10", "materials methodology/source notes; fixed reference text"),
        ("9 .경비계획", "D16:D17", "expense calculation basis notes; fixed reference text"),
        ("9 .경비계획", "D20", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D36:D37", "expense calculation basis notes; fixed reference text"),
        ("9 .경비계획", "D40", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D45", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D56:D57", "expense calculation basis notes; fixed reference text"),
        ("9 .경비계획", "D60", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D65", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D76:D77", "expense calculation basis notes; fixed reference text"),
        ("9 .경비계획", "D80", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D85", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D96:D97", "expense calculation basis notes; fixed reference text"),
        ("9 .경비계획", "D100", "expense calculation basis note; fixed reference text"),
        ("9 .경비계획", "D105", "expense calculation basis note; fixed reference text"),
        ("12 손익계획", "B39", "shipping benchmark source note; fixed reference text"),
        ("14. 현금흐름계획", "B25", "cash-flow method note; fixed reference text"),
    ]
    out.extend(e(sheet, refs, "legacy_constant", reason, "preserve") for sheet, refs, reason in preserve)
    return out


def map_entries_for_source(map_data: dict, source: Path) -> tuple[list[dict], list[dict]]:
    got = sha256(source)
    expected = map_data.get("source", {}).get("sha256")
    if expected != got:
        raise RuntimeError(f"source version changed: map sha256={expected}, current sha256={got}")
    entries = map_data.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError("map must contain non-empty entries")
    return entries, map_data.get("inventory", [])


_MC_QNAME_ATTRIBUTES = {
    "Ignorable", "MustUnderstand", "ProcessContent", "PreserveAttributes",
    "PreserveElements", "Requires",
}


def _validate_mc_qnames(document: minidom.Document, source_name: str) -> None:
    """Fail closed when MC QName-valued attributes contain undeclared prefixes.

    ElementTree serialization can silently change namespace prefixes while leaving
    lexical values such as ``mc:Ignorable=\"x15\"`` untouched.  A resulting
    workbook then fails to open.  Walk the original DOM with an in-scope prefix
    map so nested namespace rebindings are handled correctly before any mutation.
    """
    def walk(node: minidom.Node, nsmap: dict[str, str]) -> None:
        if node.nodeType != node.ELEMENT_NODE:
            return
        current = dict(nsmap)
        for i in range(node.attributes.length):
            attr = node.attributes.item(i)
            if attr.name == "xmlns":
                current[""] = attr.value
            elif attr.name.startswith("xmlns:"):
                current[attr.name.split(":", 1)[1]] = attr.value
        for i in range(node.attributes.length):
            attr = node.attributes.item(i)
            is_mc_attr = attr.namespaceURI == NS_MC and attr.localName in _MC_QNAME_ATTRIBUTES
            # Choice/@Requires is intentionally unqualified by OOXML, while
            # the other MC controls carry the mc: prefix.
            is_choice_requires = (
                attr.localName == "Requires" and attr.namespaceURI in (None, "")
                and node.namespaceURI == NS_MC
            )
            if not (is_mc_attr or is_choice_requires):
                continue
            for token in attr.value.split():
                if attr.localName in {"ProcessContent", "PreserveAttributes", "PreserveElements"}:
                    # These controls contain QName lists; unprefixed local
                    # names are valid and need no prefix declaration.
                    if ":" not in token:
                        continue
                    prefix = token.split(":", 1)[0]
                else:
                    # Ignorable/MustUnderstand/Requires contain namespace
                    # prefix lists, including bare prefixes such as x15/hs.
                    prefix = token.split(":", 1)[0] if ":" in token else token
                if prefix and prefix not in current:
                    raise ValueError(
                        f"undeclared namespace prefix {prefix!r} in mc:{attr.localName} "
                        f"of {source_name}"
                    )
        for child in node.childNodes:
            if child.nodeType == child.ELEMENT_NODE:
                walk(child, current)

    walk(document.documentElement, {})


def _dom_elements(document: minidom.Document, namespace: str, local_name: str) -> list[minidom.Element]:
    """Return namespace-aware DOM elements without relying on lexical prefixes."""
    return list(document.getElementsByTagNameNS(namespace, local_name))


def _dom_attr(element: minidom.Element, name: str) -> str | None:
    return element.getAttribute(name) if element.hasAttribute(name) else None


def _dom_clear_cell_value(cell: minidom.Element) -> None:
    for child in list(cell.childNodes):
        if child.nodeType == child.ELEMENT_NODE and (
            child.namespaceURI == NS_MAIN and child.localName in {"v", "is"}
        ):
            cell.removeChild(child)
    if cell.hasAttribute("t"):
        cell.removeAttribute("t")


def _dom_invalidate_formula_cache(cell: minidom.Element) -> bool:
    formula = next((child for child in cell.childNodes
                    if child.nodeType == child.ELEMENT_NODE
                    and child.namespaceURI == NS_MAIN and child.localName == "f"), None)
    if formula is None:
        return False
    value = next((child for child in cell.childNodes
                  if child.nodeType == child.ELEMENT_NODE
                  and child.namespaceURI == NS_MAIN and child.localName == "v"), None)
    if value is not None:
        for child in list(value.childNodes):
            value.removeChild(child)
    return True


def _serialize_dom(xml_bytes: bytes, source_name: str) -> minidom.Document:
    """Parse and validate an XML part while retaining original namespace lexemes."""
    document = minidom.parseString(xml_bytes)
    _validate_mc_qnames(document, source_name)
    return document


def _ref_sort_key(ref: str) -> tuple[int, int]:
    m = CELL_RE.match(ref)
    return (int(m.group(2)), col_num(m.group(1))) if m else (0, 0)


def blank_copy(source: Path, map_path: Path, out: Path, allow_missing: bool = False) -> dict:
    if out.exists():
        raise FileExistsError(f"refusing to overwrite output: {out}")
    map_data = json.loads(map_path.read_text(encoding="utf-8"))
    entries, _ = map_entries_for_source(map_data, source)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as zin:
        sheets = dict(workbook_sheets(zin))
        shared = load_shared(zin)
        by_sheet: dict[str, set[str]] = {}
        preserved_by_sheet: dict[str, dict[str, str]] = {}
        action_by_cell: dict[tuple[str, str], str] = {}
        for ent in entries:
            if "action" not in ent:
                raise ValueError("map entry missing explicit action")
            action = ent["action"]
            if action not in {"clear", "preserve"}:
                raise ValueError(f"invalid map action: {action!r}")
            if ent.get("sheet") not in sheets:
                raise ValueError(f"map references missing sheet: {ent.get('sheet')}")
            refs = ent.get("range") or ent.get("cell")
            if not refs:
                raise ValueError("map entry missing range/cell")
            expanded = expand_ref(refs)
            for cell in expanded:
                key = (ent["sheet"], cell)
                prior = action_by_cell.get(key)
                if prior and prior != action:
                    raise ValueError(f"conflicting map actions for {ent['sheet']}!{cell}")
                action_by_cell[key] = action
            if action == "clear":
                by_sheet.setdefault(ent["sheet"], set()).update(expanded)
            else:
                reason = ent.get("reason", "mapped preserve cell")
                preserved_by_sheet.setdefault(ent["sheet"], {}).update({r: reason for r in expanded})
        modified: dict[str, bytes] = {}
        receipt = {"schema": "gg-xlsx-template-receipt/v1", "source": {"path": str(source.resolve()),
                    "sha256": sha256(source), "size": source.stat().st_size},
                   "output": {"path": str(out.resolve())}, "cleared": [], "preserved": [],
                   "formulaCellsProtected": 0, "mergedCellsProtected": 0,
                   "formulaCachesInvalidated": 0, "ambiguousCount": 0, "missingCells": [], "errors": []}
        for name, target in sheets.items():
            sheet_bytes = zin.read(target)
            root = ET.fromstring(sheet_bytes)
            # Mutate the original namespace-aware DOM. ElementTree's serializer
            # can rewrite prefixes and drop declarations referenced by MC QName
            # values such as mc:Ignorable="x15".
            sheet_dom = _serialize_dom(sheet_bytes, target)
            dom_cells = {
                _dom_attr(cell, "r"): cell
                for cell in _dom_elements(sheet_dom, NS_MAIN, "c")
                if _dom_attr(cell, "r")
            }
            anchors, nonanchors = merged_cells(root)
            wanted = by_sheet.get(name, set())
            seen: set[str] = set()
            for c in root.findall(f".//{local('c')}"):
                ref = c.attrib.get("r")
                if not ref:
                    continue
                seen.add(ref)
                dom_cell = dom_cells.get(ref)
                if dom_cell is None:
                    raise ValueError(f"worksheet cell missing from namespace-preserving DOM: {target}!{ref}")
                formula = c.find(local("f"))
                if formula is not None:
                    # Invalidate every formula cache in a blank template; keep f text.
                    v = c.find(local("v"))
                    if v is not None and v.text is not None:
                        _dom_invalidate_formula_cache(dom_cell)
                        receipt["formulaCachesInvalidated"] += 1
                    if ref in wanted:
                        receipt["formulaCellsProtected"] += 1
                        receipt["preserved"].append({"sheet": name, "cell": ref, "reason": "formula"})
                    continue
                if ref not in wanted:
                    if ref in preserved_by_sheet.get(name, {}):
                        receipt["preserved"].append({"sheet": name, "cell": ref,
                                                     "reason": preserved_by_sheet[name][ref]})
                    continue
                if ref in nonanchors:
                    receipt["mergedCellsProtected"] += 1
                    receipt["preserved"].append({"sheet": name, "cell": ref, "reason": "merged_nonanchor"})
                    continue
                # Explicitly mapped data cell: remove value while retaining style and cell node.
                old = text_value(c, shared)
                _dom_clear_cell_value(dom_cell)
                receipt["cleared"].append({"sheet": name, "cell": ref, "oldValue": old})
            # A mapped coordinate with no <c> node cannot be cleared; report it
            # instead of silently skipping it.
            for ref in sorted(wanted - seen, key=_ref_sort_key):
                receipt["missingCells"].append({"sheet": name, "cell": ref})
            modified[target] = sheet_dom.toxml(encoding="utf-8")
        if receipt["missingCells"] and not allow_missing:
            shown = ", ".join(f"{m['sheet']}!{m['cell']}" for m in receipt["missingCells"][:10])
            extra = len(receipt["missingCells"]) - 10
            raise ValueError("매핑된 셀이 원본에 없음: " + shown + (f" 외 {extra}건" if extra > 0 else ""))
        targeted = {(r["sheet"], r["cell"]) for r in receipt["cleared"]}
        preserved = {(r["sheet"], r["cell"]) for r in receipt["preserved"]}
        # Hard-coded numerics left outside the explicit map are intentionally reported
        # as review items; they may be valid benchmarks, controls, or legacy sample data.
        unclassified = []
        unclassified_text = []
        for name, target in sheets.items():
            root = ET.fromstring(zin.read(target))
            for c in root.findall(f".//{local('c')}"):
                ref = c.attrib.get("r")
                if not ref or c.find(local("f")) is not None or (name, ref) in targeted or (name, ref) in preserved:
                    continue
                val = text_value(c, shared)
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    unclassified.append({"sheet": name, "cell": ref, "value": val})
                elif isinstance(val, str) and val and is_reference_text(val):
                    # Narrative/reference text outside the explicit map is
                    # retained but disclosed. Ordinary worksheet labels are
                    # treated as fixed structure and are not ambiguity items.
                    unclassified_text.append({"sheet": name, "cell": ref, "value": val})
        receipt["unclassifiedNumericCells"] = len(unclassified)
        receipt["unclassifiedNumericSample"] = unclassified[:40]
        receipt["unclassifiedTextCells"] = len(unclassified_text)
        receipt["unclassifiedTextSample"] = unclassified_text[:40]
        receipt["ambiguousCount"] = len(unclassified)
        receipt["classification"] = {
            "clearMapped": len(receipt["cleared"]),
            "preserveMapped": len(receipt["preserved"]),
            "unclassifiedNumeric": len(unclassified),
            "unclassifiedText": len(unclassified_text),
            "unclassifiedValuesRemain": bool(unclassified or unclassified_text),
        }
        # Force Excel recalculation on open without touching formulas.
        try:
            wb_dom = _serialize_dom(zin.read("xl/workbook.xml"), "xl/workbook.xml")
            calc_nodes = _dom_elements(wb_dom, NS_MAIN, "calcPr")
            calc = calc_nodes[0] if calc_nodes else None
            if calc is None:
                calc = wb_dom.createElementNS(NS_MAIN, "calcPr")
                wb_dom.documentElement.appendChild(calc)
            for key, value in (("calcMode", "auto"), ("fullCalcOnLoad", "1"), ("forceFullCalc", "1")):
                calc.setAttribute(key, value)
            modified["xl/workbook.xml"] = wb_dom.toxml(encoding="utf-8")
        except KeyError:
            receipt["errors"].append("workbook.xml missing; calculation mode not updated")
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                data = modified.get(info.filename, zin.read(info.filename))
                zout.writestr(info, data)
    receipt["output"]["sha256"] = sha256(out)
    receipt["output"]["size"] = out.stat().st_size
    # Any retained text outside the map (labels, notes, or legacy sample prose)
    # keeps the artifact review-only; the receipt must not call it publication-ready.
    retained_legacy = any("legacy" in reason.lower() or "reference" in reason.lower()
                          for reasons in preserved_by_sheet.values() for reason in reasons.values())
    receipt["output"]["status"] = "partial" if (receipt["ambiguousCount"] or receipt.get("unclassifiedTextCells")
                                                or retained_legacy or receipt["missingCells"]) else "blank_template"
    receipt["output"]["calculationStatus"] = "recalculate_on_open; cached_formula_values_invalidated"
    return receipt


def cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="inspect and create a source-bound reusable XLSX template")
    sp = p.add_subparsers(dest="cmd", required=True)
    i = sp.add_parser("inspect")
    i.add_argument("--source", required=True, type=Path)
    i.add_argument("--out-map", required=True, type=Path)
    i.add_argument("--report", type=Path)
    i.add_argument("--legacy-map", action="store_true",
                   help="use the hard-coded legacy 17-sheet map instead of the inventory-derived map")
    c = sp.add_parser("clear")
    c.add_argument("--source", required=True, type=Path)
    c.add_argument("--map", required=True, type=Path)
    c.add_argument("--out", required=True, type=Path)
    c.add_argument("--receipt", type=Path)
    c.add_argument("--allow-missing", action="store_true",
                   help="do not fail when a mapped cell has no node in the source; report it in the receipt")
    args = p.parse_args(argv)
    try:
        if args.cmd == "inspect":
            r = inspect_source(args.source, args.out_map, args.report, legacy_map=args.legacy_map)
            print(json.dumps({"status": "inspected", "source": r["source"], "entries": len(r["entries"]),
                              "entries_source": r["entriesSource"],
                              "sheets": len(r["sheets"]), "map": str(args.out_map)}, ensure_ascii=False))
        else:
            if args.out.exists():
                raise FileExistsError(f"refusing to overwrite output: {args.out}")
            if args.receipt and args.receipt.exists():
                raise FileExistsError(f"refusing to overwrite receipt: {args.receipt}")
            # Stage both files first.  Publication uses rollback on ordinary
            # exceptions; the receipt is staged before the workbook is made
            # visible, but two separate renames are not crash-atomic.
            staged_out = args.out.with_name(f".{args.out.name}.tmp-{os.getpid()}")
            staged_receipt = (args.receipt.with_name(f".{args.receipt.name}.tmp-{os.getpid()}")
                              if args.receipt else None)
            if staged_out.exists() or (staged_receipt and staged_receipt.exists()):
                raise FileExistsError("staging path already exists")
            published_out = False
            try:
                r = blank_copy(resolve_source(args.source).resolve(), args.map.resolve(), staged_out.resolve(),
                               allow_missing=args.allow_missing)
                r["output"]["path"] = str(args.out.resolve())
                if staged_receipt:
                    staged_receipt.parent.mkdir(parents=True, exist_ok=True)
                    staged_receipt.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(staged_out, args.out)
                published_out = True
                if staged_receipt:
                    os.replace(staged_receipt, args.receipt)
            except Exception:
                for pending in (staged_out, staged_receipt):
                    if pending and pending.exists():
                        pending.unlink()
                if published_out and args.out.exists():
                    args.out.unlink()
                raise
            print(json.dumps({"status": r["output"]["status"], "out": r["output"],
                              "cleared": len(r["cleared"]), "formulaProtected": r["formulaCellsProtected"],
                              "formulaCachesInvalidated": r["formulaCachesInvalidated"],
                              "missing": len(r["missingCells"])}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"BLOCK: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(cli(sys.argv[1:]))
