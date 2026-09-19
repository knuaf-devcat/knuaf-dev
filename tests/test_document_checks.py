"""audit H1: merge markers '<' / '^' must not count as filled cells."""
import re


import gg_document


def test_merge_markers_are_empty():
    assert not gg_document._filled_cell("<")
    assert not gg_document._filled_cell("^")


def test_climate_footer_with_only_markers_is_unfilled():
    rows = [["관측장소", "[확인 필요]"] + ["<"] * 11 + ["[확인 필요]"]]
    assert gg_document._field_filled(rows, re.compile("관측장소")) is False


def test_real_value_is_filled():
    rows = [["관측장소", "정읍"] + ["<"] * 11 + ["[확인 필요]"]]
    assert gg_document._field_filled(rows, re.compile("관측장소")) is True
