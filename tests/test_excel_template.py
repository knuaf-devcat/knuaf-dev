"""audit H4/H5/H6: inspect map derives from the inventory, clear reports mapped
cells that do not exist, and print_titles lands inside <definedNames>."""
import json
import zipfile

import pytest

from conftest import parse_json, run_script

openpyxl = pytest.importorskip("openpyxl")

SHEET_A = "1. 입력"
SHEET_B = "계획 시트"


def build_workbook(path):
    """Two sheets: numbers, labels, one formula, one merged range."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = SHEET_A
    ws["A1"] = "기초 정보"          # column A label
    ws["B1"] = "면적(평):"          # colon label
    ws["C1"] = 600                  # number -> input candidate
    ws["B2"] = "품목"               # short all-Korean header
    ws["C2"] = "사과 2023년산 특등급 샘플"  # text with digits -> input candidate
    ws["B3"] = "합계"
    ws["C3"] = "=C1*2"              # formula
    ws["B5"] = "병합 제목"
    ws.merge_cells("B5:D5")         # B5 anchor, C5/D5 non-anchors
    ws2 = wb.create_sheet(SHEET_B)
    ws2["B2"] = 12.5
    ws2["C2"] = "메모 값 abc"
    wb.save(path)


@pytest.fixture
def source(tmp_path):
    src = tmp_path / "원본 계획.xlsx"
    build_workbook(src)
    return src


def inspect(src, out_map, *extra):
    return run_script("gg_excel_template.py", "inspect", "--source", src, "--out-map", out_map, *extra)


def clear(src, map_path, out, receipt, *extra):
    return run_script("gg_excel_template.py", "clear", "--source", src, "--map", map_path,
                      "--out", out, "--receipt", receipt, *extra)


def test_inspect_derives_entries_from_inventory(source, tmp_path):
    out_map = tmp_path / "map.json"
    r = inspect(source, out_map)
    assert r.returncode == 0, r.stderr
    summary = parse_json(r.stdout)
    assert summary["entries_source"] == "inventory"
    assert summary["entries"] > 0
    data = json.loads(out_map.read_text(encoding="utf-8"))
    assert data["schema"] == "gg-xlsx-template-map/v1"
    assert data["entriesSource"] == "inventory"
    sheet_names = {s["name"] for s in data["sheets"]}
    assert sheet_names == {SHEET_A, SHEET_B}
    entries = data["entries"]
    assert all(e["sheet"] in sheet_names for e in entries)
    assert all(e["action"] in {"clear", "preserve"} and e["explicit"] for e in entries)
    by_cell = {(e["sheet"], e["range"]): e for e in entries}
    # formula cell is not an entry at all
    assert (SHEET_A, "C3") not in by_cell
    # merged non-anchors are skipped, anchor label is preserved
    assert (SHEET_A, "C5") not in by_cell and (SHEET_A, "D5") not in by_cell
    assert by_cell[(SHEET_A, "B5")]["action"] == "preserve"
    # literal inputs
    for key in ((SHEET_A, "C1"), (SHEET_A, "C2"), (SHEET_B, "B2"), (SHEET_B, "C2")):
        assert by_cell[key]["action"] == "clear", key
        assert by_cell[key]["role"] == "input_candidate"
        assert by_cell[key]["reason"] == "literal value in source workbook"
    # labels
    for key in ((SHEET_A, "A1"), (SHEET_A, "B1"), (SHEET_A, "B2"), (SHEET_A, "B3")):
        assert by_cell[key]["action"] == "preserve", key
        assert by_cell[key]["role"] == "label"


def test_inspect_then_clear_blanks_literals_and_keeps_formula(source, tmp_path):
    out_map = tmp_path / "map.json"
    assert inspect(source, out_map).returncode == 0
    out = tmp_path / "blank.xlsx"
    receipt = tmp_path / "receipt.json"
    r = clear(source, out_map, out, receipt)
    assert r.returncode == 0, r.stderr
    summary = parse_json(r.stdout)
    assert summary["cleared"] >= 4
    assert summary["missing"] == 0
    wb = openpyxl.load_workbook(out)
    ws, ws2 = wb[SHEET_A], wb[SHEET_B]
    assert ws["C1"].value is None and ws["C2"].value is None
    assert ws2["B2"].value is None and ws2["C2"].value is None
    assert ws["C3"].value == "=C1*2"
    assert ws["B1"].value == "면적(평):" and ws["A1"].value == "기초 정보"
    assert ws["B5"].value == "병합 제목"
    rec = json.loads(receipt.read_text(encoding="utf-8"))
    assert rec["missingCells"] == []
    assert rec["formulaCellsProtected"] == 0
    # source untouched
    assert openpyxl.load_workbook(source)[SHEET_A]["C1"].value == 600


def test_inspect_legacy_map_fails_on_missing_sheet(source, tmp_path):
    out_map = tmp_path / "legacy-map.json"
    r = inspect(source, out_map, "--legacy-map")
    assert r.returncode == 2
    assert r.stderr.startswith("BLOCK: map references missing sheet")
    assert not out_map.exists()


def _map_with_extra_cell(source, tmp_path, extra_cell="Z99"):
    out_map = tmp_path / "map.json"
    assert inspect(source, out_map).returncode == 0
    data = json.loads(out_map.read_text(encoding="utf-8"))
    data["entries"].append({"sheet": SHEET_B, "range": extra_cell, "semanticField": "ghost",
                            "role": "input_candidate", "reason": "test", "action": "clear",
                            "explicit": True})
    edited = tmp_path / "map-missing.json"
    edited.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return edited


def test_clear_fails_closed_on_mapped_cell_missing_from_source(source, tmp_path):
    map_path = _map_with_extra_cell(source, tmp_path)
    out = tmp_path / "blank.xlsx"
    receipt = tmp_path / "receipt.json"
    r = clear(source, map_path, out, receipt)
    assert r.returncode == 2
    assert r.stderr.startswith("BLOCK: 매핑된 셀이 원본에 없음: ")
    assert f"{SHEET_B}!Z99" in r.stderr
    assert not out.exists() and not receipt.exists()


def test_clear_allow_missing_reports_in_receipt(source, tmp_path):
    map_path = _map_with_extra_cell(source, tmp_path)
    out = tmp_path / "blank.xlsx"
    receipt = tmp_path / "receipt.json"
    r = clear(source, map_path, out, receipt, "--allow-missing")
    assert r.returncode == 0, r.stderr
    summary = parse_json(r.stdout)
    assert summary["missing"] == 1
    assert summary["status"] == "partial"
    rec = json.loads(receipt.read_text(encoding="utf-8"))
    assert rec["missingCells"] == [{"sheet": SHEET_B, "cell": "Z99"}]
    assert rec["output"]["status"] == "partial"


def test_clear_refuses_to_overwrite_output(source, tmp_path):
    out_map = tmp_path / "map.json"
    assert inspect(source, out_map).returncode == 0
    out = tmp_path / "blank.xlsx"
    out.write_bytes(b"x")
    r = clear(source, out_map, out, tmp_path / "receipt.json")
    assert r.returncode == 2 and "refusing to overwrite" in r.stderr
    assert out.read_bytes() == b"x"


# --- H6: print titles ---------------------------------------------------------

def _print_map(source, sheet, **plan):
    import gg_excel_template as tpl
    return {"schema": "gg-xlsx-print-map/v1", "source": {"sha256": tpl.sha256(source)},
            "sheets": [{"sheet": sheet, "fit_width": 1, "fit_height": 0, "reason": "test", **plan}]}


def strip_defined_names(src, dst):
    """Copy a workbook without its (empty) <definedNames/> element."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", compression=zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "xl/workbook.xml":
                assert b"<definedNames/>" in data
                data = data.replace(b"<definedNames/>", b"")
            zout.writestr(info, data)
    return dst


@pytest.mark.parametrize("has_container", [False, True])
def test_print_titles_inserted_inside_defined_names(source, tmp_path, has_container):
    if not has_container:
        source = strip_defined_names(source, tmp_path / "no-names.xlsx")
    with zipfile.ZipFile(source) as z:
        assert (b"<definedNames" in z.read("xl/workbook.xml")) is has_container
    map_path = tmp_path / "print-map.json"
    map_path.write_text(json.dumps(_print_map(source, SHEET_A, print_titles={"rows": [1, 2]}),
                                   ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "print.xlsx"
    receipt = tmp_path / "print-receipt.json"
    r = run_script("gg_excel_print.py", "--source", source, "--map", map_path, "--out", out, "--receipt", receipt)
    assert r.returncode == 0, r.stderr
    assert parse_json(r.stdout)["status"] == "layout_copy_created"
    with zipfile.ZipFile(out) as z:
        xml = z.read("xl/workbook.xml").decode("utf-8")
    assert '<definedNames><definedName name="_xlnm.Print_Titles"' in xml
    assert xml.index("</sheets>") < xml.index("<definedNames>")
    if "<calcPr" in xml:
        assert xml.index("</definedNames>") < xml.index("<calcPr")
    wb = openpyxl.load_workbook(out)
    ws = wb[SHEET_A]
    assert ws.print_title_rows == "$1:$2"
    assert wb.defined_names is not None


def test_number_formats_do_not_wrap(source, tmp_path):
    map_path = tmp_path / "print-map.json"
    map_path.write_text(json.dumps(_print_map(source, SHEET_A, number_formats=[{"cells": ["C1"], "format": "#,##0"}],
                                              wrap_cells=["C2"]), ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "print.xlsx"
    receipt = tmp_path / "print-receipt.json"
    r = run_script("gg_excel_print.py", "--source", source, "--map", map_path, "--out", out, "--receipt", receipt)
    assert r.returncode == 0, r.stderr
    rec = json.loads(receipt.read_text(encoding="utf-8"))
    changes = {c["cell"]: c for c in rec["style_changes"]}
    assert changes["C1"]["wrap_text"] is False and changes["C1"]["number_format"] == "#,##0"
    assert changes["C2"]["wrap_text"] is True
    ws = openpyxl.load_workbook(out)[SHEET_A]
    assert ws["C1"].number_format == "#,##0"
    assert not ws["C1"].alignment.wrap_text
    assert ws["C2"].alignment.wrap_text


# --- structure preservation: odd sheet names, hidden sheets, formulas --------

SHEET_SPACE = " 2. 판매계획"   # leading space on purpose
SHEET_HIDDEN = "참고 데이터"


def _formula_text(value):
    """Normalise openpyxl formula values (str / ArrayFormula / DataTableFormula)."""
    if isinstance(value, str):
        return value if value.startswith("=") else None
    text = getattr(value, "text", None)
    if text is None:
        return None
    return (type(value).__name__, getattr(value, "ref", None), text)


def formula_map(ws):
    return {c.coordinate: _formula_text(c.value)
            for row in ws.iter_rows() for c in row if _formula_text(c.value) is not None}


def assert_structure_preserved(src, out):
    """Sheet names/order, sheet_state, merged ranges and formulas must survive `clear`."""
    wb_src = openpyxl.load_workbook(src)
    wb_out = openpyxl.load_workbook(out)
    assert wb_out.sheetnames == wb_src.sheetnames
    for name in wb_src.sheetnames:
        ws_src, ws_out = wb_src[name], wb_out[name]
        assert ws_out.sheet_state == ws_src.sheet_state, name
        assert {str(r) for r in ws_out.merged_cells.ranges} == {str(r) for r in ws_src.merged_cells.ranges}, name
        assert formula_map(ws_out) == formula_map(ws_src), name


def build_structured_workbook(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = SHEET_SPACE
    ws["A1"] = "판매 계획"
    ws.merge_cells("A1:C1")
    ws["A2"] = "수량:"
    ws["B2"] = 120
    ws["A3"] = "단가:"
    ws["B3"] = 3500.5
    ws["A4"] = "매출"
    ws["B4"] = "=B2*B3"
    ws["B5"] = f"=SUM(B2:B3)+'{SHEET_HIDDEN}'!B1"
    hidden = wb.create_sheet(SHEET_HIDDEN)
    hidden.sheet_state = "hidden"
    hidden["A1"] = "기준값"
    hidden["B1"] = 42                       # literal value in hidden sheet
    hidden["B2"] = "=B1*10"
    hidden["A4"] = "비고"
    hidden.merge_cells("A4:B4")
    wb.save(path)


@pytest.fixture
def structured_source(tmp_path):
    src = tmp_path / "구조 원본.xlsx"
    build_structured_workbook(src)
    return src


def test_inspect_keeps_exact_sheet_names_and_lists_hidden(structured_source, tmp_path):
    out_map = tmp_path / "map.json"
    r = inspect(structured_source, out_map)
    assert r.returncode == 0, r.stderr
    assert parse_json(r.stdout)["sheets"] == 2
    data = json.loads(out_map.read_text(encoding="utf-8"))
    names = [s["name"] for s in data["sheets"]]
    assert names == [SHEET_SPACE, SHEET_HIDDEN]          # exact, order kept, leading space intact
    assert names[0].startswith(" ")
    hidden_summary = data["sheets"][1]
    assert hidden_summary["cellCount"] > 0 and hidden_summary["formulaCount"] == 1
    assert {e["sheet"] for e in data["entries"]} == {SHEET_SPACE, SHEET_HIDDEN}


def test_clear_preserves_structure_and_empties_literals(structured_source, tmp_path):
    out_map = tmp_path / "map.json"
    assert inspect(structured_source, out_map).returncode == 0
    out = tmp_path / "blank.xlsx"
    receipt = tmp_path / "receipt.json"
    r = clear(structured_source, out_map, out, receipt)
    assert r.returncode == 0, r.stderr
    summary = parse_json(r.stdout)
    assert summary["missing"] == 0
    assert summary["cleared"] >= 3
    assert_structure_preserved(structured_source, out)
    wb = openpyxl.load_workbook(out)
    ws, hidden = wb[SHEET_SPACE], wb[SHEET_HIDDEN]
    assert hidden.sheet_state == "hidden"
    assert ws["B2"].value is None and ws["B3"].value is None
    assert hidden["B1"].value is None
    assert ws["B4"].value == "=B2*B3" and hidden["B2"].value == "=B1*10"
    assert ws["A1"].value == "판매 계획" and ws["A2"].value == "수량:"
    assert {str(m) for m in ws.merged_cells.ranges} == {"A1:C1"}
    assert {str(m) for m in hidden.merged_cells.ranges} == {"A4:B4"}
    rec = json.loads(receipt.read_text(encoding="utf-8"))
    assert rec["missingCells"] == []


def test_assert_structure_preserved_detects_drift(structured_source, tmp_path):
    drifted = tmp_path / "drift.xlsx"
    wb = openpyxl.load_workbook(structured_source)
    wb[SHEET_HIDDEN].sheet_state = "visible"
    wb.save(drifted)
    with pytest.raises(AssertionError):
        assert_structure_preserved(structured_source, drifted)
