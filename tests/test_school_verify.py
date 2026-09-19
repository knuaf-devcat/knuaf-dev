"""gg_school_verify: the independent recalculation behind the submission gate.

1,085 lines with no test. This module recomputes the 5-year plan in Decimal so
the workbook's own numbers can be checked against something. If it is wrong,
every verification downstream agrees with a wrong answer — so the tests here
assert the accounting identities the module claims, not one frozen output.
"""
from decimal import Decimal

import pytest

pytest.importorskip("openpyxl")

import gg_school_verify as sv

D = Decimal

BASE = {
    "profile": "school_17_sheet_v1", "unit": "천원", "quantity_unit": "kg",
    "writing_year": 2026, "source_refs": ["answers.md#재무"],
    "production_evidence": {k: "인터뷰 Q2 근거" for k in
                            ("area", "seedlings", "yield", "growth", "commodity")},
    "area_m2": "2000", "production_kg": "5000",
    "purchase_price": "8", "direct_price": "12",
    "purchase_share": "0.6", "direct_share": "0.4",
    "land": "0", "facility": "60000", "equipment": "20000",
    "equity": "40000", "loan": "40000", "loan_rate": "0.02", "salvage": "6000",
    "materials": "5000", "labor": "4000", "packing": "1000", "transport": "800",
    "household": "12000", "repair_facility_rate": "0.01",
    "repair_equipment_rate": "0.02", "utility_per_10a": "300",
    "inflation": "1.02", "grace": 2, "term": 5, "life": 10,
}
HISTORY_YEARS = [2021, 2022, 2023, 2024, 2025]


def plan(**over):
    return sv.calculate_school_expected({**BASE, **over})["expected_years"]


# --- the identities the module exists to check --------------------------------

def test_the_balance_sheet_balances_every_year():
    """자산 = 부채 + 자본. If this drifts, the gate approves an impossible plan."""
    for i, y in enumerate(plan(), 1):
        assert y["total_assets"] == y["total_liab_eq"], f"{i}년차 대차 불일치"


def test_cash_rolls_forward_from_one_year_to_the_next():
    years = plan()
    for i in range(1, len(years)):
        expected = years[i - 1]["cash"] + years[i]["net_cf"]
        assert years[i]["cash"] == expected, f"{i + 1}년차 현금 이월 불일치"


# grace/term combinations worth separating: the default never exhausts the loan,
# and a term that does not divide evenly leaves a residue the last payment must
# be capped to. Only the second one exercises that cap.
SCHEDULES = [
    pytest.param({"grace": 2, "term": 5}, id="거치2-상환5"),
    pytest.param({"grace": 0, "term": 3}, id="거치0-상환3-잔여발생"),
    pytest.param({"grace": 0, "term": 7}, id="거치0-상환7-기간초과"),
    pytest.param({"grace": 5, "term": 5}, id="거치5-창중상환없음"),
]


@pytest.mark.parametrize("schedule", SCHEDULES)
def test_repayment_is_never_negative(schedule):
    """A negative principal would be the plan lending money back to the bank."""
    assert all(y["principal"] >= 0 for y in plan(**schedule))


@pytest.mark.parametrize("schedule", SCHEDULES)
def test_the_loan_balance_only_falls_and_never_goes_negative(schedule):
    years = plan(**schedule)
    balances = [y["ending_loan"] for y in years]
    assert balances == sorted(balances, reverse=True), "잔액이 다시 늘어남"
    assert all(b >= 0 for b in balances), "상환이 잔액을 넘어 음수가 됨"


@pytest.mark.parametrize("schedule", SCHEDULES)
def test_total_repaid_never_exceeds_the_loan(schedule):
    """The cap on the final payment is what keeps this true when the term does
    not divide evenly; without it the plan repays more than it borrowed."""
    years = plan(**schedule)
    assert sum(y["principal"] for y in years) <= D(BASE["loan"])


def test_the_grace_period_is_honoured_then_repayment_starts():
    years = plan(grace=2, term=5)
    assert [y["principal"] for y in years[:2]] == [0, 0], "거치기간에 원금을 갚음"
    assert all(y["principal"] > 0 for y in years[2:]), "거치 후 상환이 시작되지 않음"


def test_a_grace_period_covering_the_window_repays_nothing():
    assert all(y["principal"] == 0 for y in plan(grace=5, term=5))


def test_interest_follows_the_outstanding_balance_down():
    years = plan()
    paying = [y for y in years if y["principal"] > 0]
    interests = [y["interest"] for y in paying]
    assert interests == sorted(interests, reverse=True), "잔액이 주는데 이자가 늘어남"


# --- depreciation stops where the school form says it stops --------------------

def test_facility_book_value_floors_at_salvage_and_never_below():
    """Book value is not a market price; it must not run past the stated floor."""
    years = plan(life=2)                       # fully depreciated inside the window
    books = [y["fac_book"] for y in years]
    assert min(books) == D("6000") == D(BASE["salvage"])
    assert all(b >= D(BASE["salvage"]) for b in books)


def test_equipment_book_value_floors_at_zero():
    years = plan(life=2)
    assert min(y["eq_book"] for y in years) == 0
    assert all(y["eq_book"] >= 0 for y in years)


def test_book_values_only_fall():
    for key in ("fac_book", "eq_book"):
        values = [y[key] for y in plan()]
        assert values == sorted(values, reverse=True), key


# --- revenue is derived, not asserted -----------------------------------------

def test_revenue_is_the_sum_of_the_two_sales_channels():
    for y in plan():
        assert y["revenue"] == y["purchase_rev"] + y["direct_rev"]


def test_selling_nothing_produces_no_revenue():
    for y in plan(production_kg="0"):
        assert y["revenue"] == 0


# --- a stated price must match the evidence behind it -------------------------

def test_a_stated_price_that_contradicts_its_own_history_is_refused():
    """The 5-year average is the evidence; the headline price cannot disagree."""
    with pytest.raises(ValueError, match="수매 평균가격.*불일치"):
        sv.calculate_school_expected({**BASE, "price_history_years": HISTORY_YEARS,
                                      "purchase_price_history": ["1", "1", "1", "1", "1"]})


def test_a_direct_price_that_contradicts_its_own_history_is_refused():
    with pytest.raises(ValueError, match="직거래 평균가격.*불일치"):
        sv.calculate_school_expected({**BASE, "price_history_years": HISTORY_YEARS,
                                      "direct_price_history": ["1", "1", "1", "1", "1"]})


def test_a_matching_history_becomes_the_effective_price():
    r = sv.calculate_school_expected({**BASE, "price_history_years": HISTORY_YEARS,
                                      "purchase_price_history": ["7", "8", "9", "8", "8"]})
    assert r["effective_purchase_price"] == D("8")


# --- the plan window ----------------------------------------------------------

def test_the_plan_covers_the_five_years_after_the_writing_year():
    r = sv.calculate_school_expected(BASE)
    assert r["years"] == [2027, 2028, 2029, 2030, 2031]
    assert [y["year"] for y in r["expected_years"]] == r["years"]


# --- to_d: Excel junk must not become a number --------------------------------

def test_to_d_accepts_the_numeric_forms_a_sheet_really_holds():
    assert sv.to_d(600) == D("600")
    assert sv.to_d(600.5) == D("600.5")
    assert sv.to_d("600.5") == D("600.5")
    assert sv.to_d(D("600.5")) == D("600.5")


@pytest.mark.parametrize("junk,why", [
    (None, "값 누락"),
    (True, "잘못된 타입"),
    (False, "잘못된 타입"),
    ("", "수치 아님"),
    ("#REF!", "수치 아님"),
    ("#DIV/0!", "수치 아님"),
    ("1,200", "수치 아님"),
    ("약 600", "수치 아님"),
    (float("inf"), "비유한"),
    (float("nan"), "비유한"),
    ([600], "잘못된 타입"),
])
def test_to_d_refuses_anything_it_cannot_trust(junk, why):
    """An error cell or a formatted string silently becoming 0 would be the worst
    possible failure here — it would look like a real figure."""
    with pytest.raises(ValueError, match=why):
        sv.to_d(junk, "C5")


def test_to_d_names_the_cell_in_its_error():
    with pytest.raises(ValueError, match="C5"):
        sv.to_d(None, "C5")


# --- the one place an #N/A is tolerated ---------------------------------------

def test_an_unused_grade_cell_may_only_hold_the_exact_allowed_values():
    for allowed in (None, "", "[해당 없음: 상품만 판매]"):
        assert sv.is_valid_unused_grade_cell(allowed, allowed) is True


@pytest.mark.parametrize("value", [
    "해당 없음", " [해당 없음: 상품만 판매]", "[해당 없음: 상품만 판매] ",
    "0", 0, "#N/A", "N/A", "없음",
])
def test_a_near_miss_in_an_unused_grade_cell_is_not_tolerated(value):
    """No whitespace normalisation: the exception is narrow on purpose."""
    assert sv.is_valid_unused_grade_cell(value, None) is False
    assert sv.is_valid_unused_grade_cell(None, value) is False


def test_error_tokens_are_the_ones_excel_actually_produces():
    for token in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#NULL!", "#NUM!", "#N/A"):
        assert token in sv.ERROR_TOKENS
