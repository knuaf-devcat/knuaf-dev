"""gg_excel_formula_patch: the only path that changes the school form's formulas.

Filling writes student values; this rewrites the workbook's own arithmetic. The
governing rule is that you may not change a formula unless you correctly state
what is in the cell right now — a patch written against a misread formula is
refused rather than applied to whatever happens to be there.
"""
import json

import pytest

import gg_excel_formula_patch as fp

openpyxl = pytest.importorskip("openpyxl")

SHEET = "1. 입력"


@pytest.fixture
def source(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = SHEET
    ws["C1"] = 600
    ws["C2"] = 2
    ws["C3"] = "=C1*2"        # the defect to correct
    ws["C4"] = 1200           # a numeric constant standing in for a lost formula
    ws["B5"] = "병합"
    ws.merge_cells("B5:D5")
    path = tmp_path / "학교 양식.xlsx"
    wb.save(path)
    return path


def patch(cell="C3", drop=(), **over):
    """`drop` removes a key outright — setting it to None would instead be
    validated as a malformed value and fail for the wrong reason."""
    base = {"sheet": SHEET, "cell": cell,
            "expected_formula": "=C1*2", "new_formula": "=C1*C2",
            "reason": "면적 단가가 상수로 고정돼 있어 단가 셀을 참조하도록 수정",
            "evidence_ref": {"source_id": "src-school", "revision": 1, "locator": "p.7"}}
    base.update(over)
    for key in (drop,) if isinstance(drop, str) else drop:
        base.pop(key, None)
    return base


def value_patch(cell="C4", expected=1200, **over):
    """A value-to-formula patch: expected_value replaces expected_formula."""
    return patch(cell=cell, drop="expected_formula", expected_value=expected, **over)


def write_map(tmp_path, source, patches, sha=None):
    m = tmp_path / "formula-map.json"
    m.write_text(json.dumps({"schema": fp.MAP_SCHEMA,
                             "source": {"sha256": sha or fp.sha256(source)},
                             "patches": patches}, ensure_ascii=False), encoding="utf-8")
    return m


def run(tmp_path, source, patches, sha=None, out_name="고친 사본.xlsx"):
    return fp._patch_copy(source, write_map(tmp_path, source, patches, sha), tmp_path / out_name)


def run_cli(tmp_path, source, patches, out="고친 사본.xlsx", receipt="영수증.json"):
    return fp.cli(["--source", str(source), "--map", str(write_map(tmp_path, source, patches)),
                   "--out", str(tmp_path / out), "--receipt", str(tmp_path / receipt)])


# --- the happy path -----------------------------------------------------------

def test_a_reviewed_formula_is_replaced_and_the_source_is_untouched(tmp_path, source):
    before = source.read_bytes()
    receipt = run(tmp_path, source, [patch()])
    ws = openpyxl.load_workbook(tmp_path / "고친 사본.xlsx")[SHEET]
    assert str(ws["C3"].value).replace(" ", "") == "=C1*C2"
    assert source.read_bytes() == before, "원본이 수정됨"
    assert receipt["formulaCachesInvalidated"] >= 1, "캐시를 비우지 않으면 낡은 합계가 남는다"


def test_the_receipt_records_both_the_old_and_the_new_formula(tmp_path, source):
    receipt = run(tmp_path, source, [patch()])
    entry = receipt["patched"][0]
    blob = json.dumps(entry, ensure_ascii=False)
    assert "C1*2" in blob and "C1*C2" in blob, entry
    assert "면적 단가" in blob, "수정 사유가 기록되지 않음"


# --- you must know what you are changing --------------------------------------

def test_a_formula_that_is_not_what_the_patch_claims_is_refused(tmp_path, source):
    """The core guard: a patch written against a misread formula must not land."""
    with pytest.raises(ValueError, match="expected formula mismatch"):
        run(tmp_path, source, [patch(expected_formula="=C1*99")])


def test_a_patch_against_a_non_formula_cell_is_refused(tmp_path, source):
    with pytest.raises(ValueError, match="not a formula cell"):
        run(tmp_path, source, [patch(cell="C1")])


def test_a_source_changed_since_review_is_refused(tmp_path, source):
    with pytest.raises(RuntimeError, match="source version changed"):
        run(tmp_path, source, [patch()], sha="0" * 64)


def test_a_merged_non_anchor_cannot_be_patched(tmp_path, source):
    with pytest.raises(ValueError, match="missing cell|merged non-anchor"):
        run(tmp_path, source, [patch(cell="C5")])


def test_two_patches_to_one_cell_are_refused(tmp_path, source):
    with pytest.raises(ValueError, match="duplicate patch target"):
        run(tmp_path, source, [patch(), patch(new_formula="=C1+C2")])


def test_a_sheet_that_does_not_exist_is_refused(tmp_path, source):
    with pytest.raises(ValueError, match="missing sheet"):
        run(tmp_path, source, [patch(sheet="없는 시트")])


# --- restoring a lost calculation from a constant ------------------------------

def test_a_numeric_constant_may_become_a_formula_when_stated_exactly(tmp_path, source):
    receipt = run(tmp_path, source, [value_patch()])
    ws = openpyxl.load_workbook(tmp_path / "고친 사본.xlsx")[SHEET]
    assert str(ws["C4"].value).replace(" ", "") == "=C1*C2"
    assert "value_to_formula" in json.dumps(receipt, ensure_ascii=False)


def test_a_constant_that_is_not_the_stated_number_is_refused(tmp_path, source):
    with pytest.raises(ValueError, match="expected value mismatch"):
        run(tmp_path, source, [value_patch(expected=999)])


def test_expected_value_may_not_target_a_formula_cell(tmp_path, source):
    with pytest.raises(ValueError, match="expected_value target is a formula cell"):
        run(tmp_path, source, [value_patch(cell="C3")])


def test_a_patch_must_state_exactly_one_precondition(tmp_path, source):
    """Neither, or both, would let a conversion happen implicitly."""
    with pytest.raises(ValueError, match="exactly one of expected_formula or expected_value"):
        run(tmp_path, source, [patch(drop="expected_formula")])
    with pytest.raises(ValueError, match="exactly one of expected_formula or expected_value"):
        run(tmp_path, source, [patch(expected_value=1200)])


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), True, "1200", None])
def test_a_non_finite_expected_value_is_refused(tmp_path, source, bad):
    with pytest.raises(ValueError):
        run(tmp_path, source, [value_patch(expected=bad)])


# --- formulas that must never be written --------------------------------------

@pytest.mark.parametrize("hostile", [
    "=DDE(\"cmd\",\"/c calc\",\"x\")",
    "=WEBSERVICE(\"http://example.invalid/x\")",
    "=HYPERLINK(\"http://example.invalid\",\"click\")",
    "=[다른파일.xlsx]Sheet1!A1",
    "=#REF!*2",
    "=C1|C2",
])
def test_external_and_dde_formulas_are_refused(tmp_path, source, hostile):
    """A patched workbook is opened by a student and a professor."""
    with pytest.raises(ValueError, match="unsafe external/DDE formula"):
        run(tmp_path, source, [patch(new_formula=hostile)])


def test_a_hostile_expected_formula_is_refused_too(tmp_path, source):
    with pytest.raises(ValueError, match="unsafe external/DDE formula"):
        run(tmp_path, source, [patch(expected_formula="=WEBSERVICE(\"http://x.invalid\")")])


@pytest.mark.parametrize("empty", ["", "   ", "=", None, 5])
def test_an_empty_or_non_string_formula_is_refused(tmp_path, source, empty):
    with pytest.raises(ValueError):
        run(tmp_path, source, [patch(new_formula=empty)])


# --- every patch needs a reason and evidence ----------------------------------

@pytest.mark.parametrize("missing", ["source_id", "revision", "locator"])
def test_every_patch_needs_full_evidence(tmp_path, source, missing):
    ev = {"source_id": "s", "revision": 1, "locator": "p.7"}
    ev.pop(missing)
    with pytest.raises(ValueError, match="evidence_ref"):
        run(tmp_path, source, [patch(evidence_ref=ev)])


@pytest.mark.parametrize("reason", ["", "   ", None])
def test_every_patch_needs_a_reason(tmp_path, source, reason):
    with pytest.raises(ValueError, match="reason must be non-empty"):
        run(tmp_path, source, [patch(reason=reason)])


def test_a_map_with_no_patches_is_refused(tmp_path, source):
    with pytest.raises(ValueError, match="non-empty patches"):
        run(tmp_path, source, [])


# --- publication is all-or-nothing --------------------------------------------

def test_the_cli_publishes_the_copy_and_the_receipt_together(tmp_path, source):
    assert run_cli(tmp_path, source, [patch()]) == 0
    assert (tmp_path / "고친 사본.xlsx").is_file()
    receipt = json.loads((tmp_path / "영수증.json").read_text(encoding="utf-8"))
    assert receipt["patched"]


def test_the_cli_refuses_to_overwrite_an_existing_output(tmp_path, source):
    assert run_cli(tmp_path, source, [patch()]) == 0
    assert run_cli(tmp_path, source, [patch()]) == 2


def test_a_refused_patch_leaves_no_output_and_no_staging_file(tmp_path, source):
    assert run_cli(tmp_path, source, [patch(expected_formula="=WRONG()")]) == 2
    assert not (tmp_path / "고친 사본.xlsx").exists()
    assert not (tmp_path / "영수증.json").exists()
    assert [p.name for p in tmp_path.glob(".*tmp-*")] == []
