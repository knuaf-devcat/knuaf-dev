"""gg_excel_fill: writing student values into the school's own workbook.

This is where a wrong number reaches a submitted thesis, and it had no test.
Every refusal below protects one of two things: the school form's own
calculations (formulas, merges, cells nobody reviewed), or the skill's
honesty rule that an unanswered question must not become a figure.
"""
import json
import zipfile

import pytest

import gg_excel_fill as fill

openpyxl = pytest.importorskip("openpyxl")

SHEET = "1. 입력"


def _keep_merged_non_anchor(path, ref="C5"):
    """Re-add an empty cell node inside a merged range.

    Excel keeps `<c>` nodes for merged non-anchor cells (they carry styles);
    openpyxl drops them on merge. Without this the fixture cannot reach the
    merged-non-anchor refusal at all — "missing cell" fires first — so the
    guard would look tested while never running.
    """
    name = "xl/worksheets/sheet1.xml"
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    xml = items[name].decode("utf-8")
    anchor = '<c r="B5"'
    cut = xml.index(anchor)
    end = xml.index("</c>", cut) + len("</c>")
    items[name] = (xml[:end] + f'<c r="{ref}"/>' + xml[end:]).encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in items.items():
            z.writestr(n, data)


@pytest.fixture
def template(tmp_path):
    """Numbers, a label, a formula (C3) and a merged range (B5:D5, B5 anchor)."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = SHEET
    ws["B1"] = "면적(평):"
    ws["C1"] = 600
    ws["B2"] = "작목:"
    ws["C2"] = "도라지"
    ws["B3"] = "합계"
    ws["C3"] = "=C1*2"
    ws["B5"] = "병합 제목"
    ws.merge_cells("B5:D5")
    path = tmp_path / "학교 양식.xlsx"
    wb.save(path)
    _keep_merged_non_anchor(path)
    return path


def entry(cell, **over):
    base = {"sheet": SHEET, "cell": cell, "role": "farm.area", "period": "2026",
            "source_note": "인터뷰 Q2", "editable": True}
    base.update(over)
    return base


def value(cell, raw=700, **over):
    base = {"sheet": SHEET, "cell": cell, "value": raw, "value_type": "integer",
            "answer_state": "provided",
            "evidence_ref": {"source_id": "src-answers", "revision": 1,
                             "locator": "L3", "origin": "factual"}}
    base.update(over)
    return base


def files(tmp_path, template, entries, values):
    m = tmp_path / "map.json"
    v = tmp_path / "values.json"
    m.write_text(json.dumps({"schema": fill.MAP_SCHEMA,
                             "template": {"sha256": fill.sha256(template)},
                             "entries": entries}, ensure_ascii=False), encoding="utf-8")
    v.write_text(json.dumps({"schema": fill.VALUES_SCHEMA, "values": values},
                            ensure_ascii=False), encoding="utf-8")
    return m, v


def run(tmp_path, template, entries, values, out_name="채운 사본.xlsx"):
    m, v = files(tmp_path, template, entries, values)
    return fill.fill_copy(template, m, v, tmp_path / out_name)


# --- the happy path, and what must survive it --------------------------------

def test_a_reviewed_cell_is_written_and_the_form_survives(tmp_path, template):
    receipt = run(tmp_path, template, [entry("C1")], [value("C1", 700)])
    out = tmp_path / "채운 사본.xlsx"
    wb = openpyxl.load_workbook(out)
    ws = wb[SHEET]
    assert ws["C1"].value == 700
    assert ws["B1"].value == "면적(평):", "매핑 밖 라벨이 바뀜"
    assert str(ws["C3"].value).replace(" ", "") == "=C1*2", "학교 양식의 수식이 사라짐"
    assert "B5:D5" in [str(r) for r in ws.merged_cells.ranges], "병합이 풀림"
    assert receipt["schema"] == "gg-xlsx-fill-receipt/v1"


def test_the_receipt_binds_every_input_and_the_output(tmp_path, template):
    receipt = run(tmp_path, template, [entry("C1")], [value("C1", 700)])
    assert receipt["template"]["sha256"] == fill.sha256(template)
    for part in ("map", "values", "output"):
        assert receipt[part]["path"]
    assert receipt["recalcNeeded"] is True, "재계산 필요 표시가 없으면 낡은 합계를 믿게 된다"


def test_a_mapped_cell_with_no_value_is_left_alone(tmp_path, template):
    """Omitting a mapped cell must not blank what the template already held."""
    run(tmp_path, template, [entry("C1"), entry("C2", role="crop")], [value("C1", 700)])
    ws = openpyxl.load_workbook(tmp_path / "채운 사본.xlsx")[SHEET]
    assert ws["C1"].value == 700
    assert ws["C2"].value == "도라지"


# --- protecting the school form's own calculations ----------------------------

# fill_copy guards formulas and merges twice: once while validating the map and
# again while writing. A written cell must be in the map, and the map loop checks
# every mapped cell first, so the map-level message is the one that reaches the
# caller. The write-level branches are unreachable defence in depth — these tests
# pin the exact message so a future refactor cannot quietly swap which layer runs.

def test_a_formula_cell_cannot_be_written(tmp_path, template):
    """C3 is the form's own calculation; overwriting it fakes a total."""
    with pytest.raises(ValueError, match="map references formula cell"):
        run(tmp_path, template, [entry("C3")], [value("C3", 1)])


def test_a_formula_cell_is_refused_even_with_nothing_written_to_it(tmp_path, template):
    """Mapping a formula cell as editable is itself the error."""
    with pytest.raises(ValueError, match="map references formula cell"):
        run(tmp_path, template, [entry("C1"), entry("C3")], [value("C1", 700)])


def test_a_merged_non_anchor_cannot_be_written(tmp_path, template):
    with pytest.raises(ValueError, match="map references merged non-anchor"):
        run(tmp_path, template, [entry("C5")], [value("C5", 1)])


def test_a_cell_outside_the_write_map_is_refused(tmp_path, template):
    """The map is what a human reviewed. Anything else is unreviewed."""
    with pytest.raises(ValueError, match="outside write-map"):
        run(tmp_path, template, [entry("C1")], [value("C2", 1)])


def test_a_sheet_that_does_not_exist_is_refused(tmp_path, template):
    with pytest.raises(ValueError, match="missing sheet"):
        run(tmp_path, template, [entry("C1", sheet="없는 시트")], [])


@pytest.mark.parametrize("editable", [None, False, "true", 1, 0])
def test_an_entry_must_be_marked_editable_explicitly(tmp_path, template, editable):
    """Only the boolean True counts; a truthy 1 or "true" does not."""
    with pytest.raises(ValueError, match="editable must be explicitly true"):
        run(tmp_path, template, [entry("C1", editable=editable)], [])


def test_an_entry_without_an_editable_key_is_refused(tmp_path, template):
    bare = {k: v for k, v in entry("C1").items() if k != "editable"}
    with pytest.raises(ValueError, match="editable must be explicitly true"):
        run(tmp_path, template, [bare], [])


def test_overlapping_map_entries_are_refused(tmp_path, template):
    with pytest.raises(ValueError, match="duplicate or overlapping"):
        run(tmp_path, template, [entry("C1"), entry("C1", role="other")], [])


def test_two_writes_to_one_cell_are_refused(tmp_path, template):
    with pytest.raises(ValueError, match="duplicate value write"):
        run(tmp_path, template, [entry("C1")], [value("C1", 1), value("C1", 2)])


# --- the map must belong to this exact file -----------------------------------

def test_a_template_changed_since_review_is_refused(tmp_path, template):
    m, v = files(tmp_path, template, [entry("C1")], [value("C1", 700)])
    wb = openpyxl.load_workbook(template)
    wb[SHEET]["C1"] = 999            # the reviewed file is not this file any more
    wb.save(template)
    with pytest.raises(RuntimeError, match="template version changed"):
        fill.fill_copy(template, m, v, tmp_path / "out.xlsx")


def test_an_existing_output_is_never_overwritten(tmp_path, template):
    run(tmp_path, template, [entry("C1")], [value("C1", 700)])
    with pytest.raises(FileExistsError):
        run(tmp_path, template, [entry("C1")], [value("C1", 800)])


# --- the honesty rule, enforced at the cell -----------------------------------

@pytest.mark.parametrize("state", ["unknown", "not_provided", "explicit_none", "withheld", "not_applicable"])
def test_an_unanswered_question_cannot_become_a_number(tmp_path, template, state):
    """SKILL.md: 미제공·모름·거부를 수치로 바꾸지 않는다. This is that rule at the cell."""
    with pytest.raises(ValueError, match="unresolved/none answers"):
        run(tmp_path, template, [entry("C1")], [value("C1", 0, answer_state=state)])


def test_an_unanswered_question_may_still_be_left_blank(tmp_path, template):
    """Blank is honest; zero is not."""
    run(tmp_path, template, [entry("C1")],
        [value("C1", None, value_type="blank", answer_state="unknown")])
    ws = openpyxl.load_workbook(tmp_path / "채운 사본.xlsx")[SHEET]
    assert ws["C1"].value is None


@pytest.mark.parametrize("missing", ["source_id", "revision", "locator", "origin"])
def test_every_written_value_needs_full_evidence(tmp_path, template, missing):
    ev = {"source_id": "s", "revision": 1, "locator": "L1", "origin": "factual"}
    ev.pop(missing)
    with pytest.raises(ValueError, match="evidence_ref"):
        run(tmp_path, template, [entry("C1")], [value("C1", 700, evidence_ref=ev)])


def test_an_unknown_evidence_origin_is_refused(tmp_path, template):
    ev = {"source_id": "s", "revision": 1, "locator": "L1", "origin": "made_up"}
    with pytest.raises(ValueError, match="origin must be one of"):
        run(tmp_path, template, [entry("C1")], [value("C1", 700, evidence_ref=ev)])


@pytest.mark.parametrize("raw,vtype", [("육백", "integer"), (True, "integer"),
                                       (600, "string"), (float("inf"), "number")])
def test_a_value_must_match_its_declared_type(tmp_path, template, raw, vtype):
    with pytest.raises(ValueError):
        run(tmp_path, template, [entry("C1")], [value("C1", raw, value_type=vtype)])


# --- the copy is a real workbook, not just a patched zip ----------------------

def test_the_output_is_a_readable_xlsx(tmp_path, template):
    run(tmp_path, template, [entry("C1")], [value("C1", 700)])
    out = tmp_path / "채운 사본.xlsx"
    with zipfile.ZipFile(out) as z:
        assert z.testzip() is None
        assert "xl/workbook.xml" in z.namelist()
    assert openpyxl.load_workbook(out)[SHEET]["C1"].value == 700
