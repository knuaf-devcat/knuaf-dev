"""gg_school_paper: the first artifact a student gets, and the input to build_docx.

The contract that matters here is honesty about missing values: SKILL.md says
unsupplied values stay `[확인 필요]`. A regression that turns a missing number
into 0 or an empty cell would put an invented figure in a submitted thesis.
"""
import re

import pytest

import gg_school_paper as sp


# --- years(): the 5-year plan window is derived, not supplied -----------------

def test_years_derives_a_five_year_window_from_the_writing_year():
    writing, start, end, span = sp.years({"writing_year": 2026})
    assert (writing, start, end) == (2026, 2027, 2031)
    assert span == [2027, 2028, 2029, 2030, 2031]


@pytest.mark.parametrize("bad", [None, "2026", 2026.0, True, 1899, 2101, {}])
def test_years_refuses_a_writing_year_it_cannot_trust(bad):
    """A wrong base year silently shifts every table in the plan."""
    with pytest.raises(ValueError, match="작성연도"):
        sp.years({"writing_year": bad})


# --- need(): missing stays missing -------------------------------------------

def test_need_takes_the_first_supplied_key():
    assert sp.need({"a": "", "b": "  ", "c": "값"}, "a", "b", "c") == "값"


@pytest.mark.parametrize("spec", [{}, {"a": None}, {"a": ""}, {"a": "   "}, None, 42, ""])
def test_need_falls_back_to_the_pending_marker_never_to_blank(spec):
    got = sp.need(spec, "a")
    assert got == sp.PENDING == "[확인 필요]"
    assert got not in ("", "0", "None")


def test_need_accepts_a_bare_string_as_the_value():
    assert sp.need("직접 값", "a") == "직접 값"


# --- the generated skeleton ---------------------------------------------------

MINIMAL = {"title": "테스트 논문", "student": "홍길동", "department": "특용작물전공",
           "advisor": "김교수", "writing_year": 2026}


def test_paper_emits_the_six_school_chapters_in_order():
    out = sp.paper(MINIMAL)
    chapters = ["Ⅰ. 머리말", "Ⅱ. 외부환경분석", "Ⅲ. 영농계획수립",
                "Ⅳ. 재무계획", "Ⅴ. 맺음말 및 발전방향", "Ⅵ. 참고문헌"]
    positions = [out.find(c) for c in chapters]
    assert all(p >= 0 for p in positions), dict(zip(chapters, positions))
    assert positions == sorted(positions), "장 순서가 어긋남"


def test_paper_keeps_supplied_values_and_marks_the_rest_pending():
    out = sp.paper(MINIMAL)
    for supplied in ("테스트 논문", "김교수"):
        assert supplied in out
    # A minimal spec supplies almost nothing, so the skeleton must be full of
    # explicit markers rather than blanks a reader could mistake for real data.
    assert out.count(sp.PENDING) > 50


def test_paper_never_invents_a_submission_date():
    out = sp.paper(MINIMAL)
    assert not re.search(r"20\d{2}\s*년\s*\d{1,2}\s*월", out), "제출일을 지어냄"


def test_paper_refuses_a_spec_without_a_writing_year():
    with pytest.raises(ValueError, match="작성연도"):
        sp.paper({k: v for k, v in MINIMAL.items() if k != "writing_year"})


# --- tables the school form fixes ---------------------------------------------

def test_table_renders_a_pipe_table_build_docx_can_parse():
    md = sp.table(["가", "나"], [[1, 2], ["a", "b"]])
    rows = md.splitlines()
    assert rows[0] == "|가|나|"
    assert rows[1] == "|---|---|"
    assert rows[2] == "|1|2|"
    assert all(r.startswith("|") and r.endswith("|") for r in rows)


def test_disaster_table_keeps_every_school_category_even_when_unanswered():
    md = sp.disaster_table({})
    for category in sp.DISASTER:
        assert category in md, category
    assert sp.PENDING in md


def test_climate_table_keeps_every_school_row_and_season_even_when_unanswered():
    """The school form fixes these rows; an unanswered one stays visible."""
    md = sp.climate_table({})
    for row in sp.CLIMATE:
        assert row in md, row
    for season in sp.SHORT_SEASONS:
        assert season in md, season
    assert sp.PENDING in md


def test_submitted_date_is_printed_when_supplied():
    """Guards the pair above: the date is absent because it was not given,
    not because the generator drops it."""
    out = sp.paper({**MINIMAL, "submitted": "2026년 12월"})
    assert "2026년 12월" in out
