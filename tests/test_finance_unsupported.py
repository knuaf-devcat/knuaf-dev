"""gg_finance.calculate 의 거절 사유가 실제로 걸린 조건을 가리키는가.

시험주행 발견 14: 재무 엑셀 생성기가 거절한 것 자체는 옳았다(5개년 계획의 감가상각을
내용연수에 맞춰 3.9배로 부풀리면 Ⅴ장 손익·현금흐름·손익분기점이 전부 어긋난다).
틀린 것은 이유를 말하는 방식이었다. 세 조건을 한 문장으로 묶어 돌려주는 바람에,
실제로 걸린 것이 "분석기간 != 내용연수"인데도 화면에는 "기존 사업 일부 투자/경영주
급여" 이야기가 떴다. 도우미는 걸리지도 않은 조건을 고치려 들고 학생은 왜 안 되는지
알 수 없었다.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "knuaf-doc" / "scripts"))

import gg_finance


def spec(**over):
    base = dict(
        profile="single_annual_cash_v1",
        crops=["딸기"],
        accounting_basis="cash_pre_tax_no_inventory",
        source_refs=["answers.md#재무"],
        unit="원",
        quantity_unit="kg",
        land="0",
        facility="195000000",
        equity="65000000",
        loan="150000000",
        loan_rate="0.015",
        discount_rate="0.03",
        salvage="0",
        start_year=2027,
        years=5,
        life=5,
        grace=5,
        term=10,
        periods=[{}] * 5,
        repayment="equal_principal",
        investment_basis="school_farm_new_business",
        owner_labor_in_costs=False,
    )
    base.update(over)
    return base


def test_pmt_refusal_names_the_repayment_method():
    r = gg_finance.calculate(spec(repayment="equal_payment"))
    assert r["status"] == "unsupported"
    assert "원금균등" in r["reason"] and "PMT" in r["reason"]
    # 값을 바꿔 도구에 맞추라고 하지 않는다 — 계획이 도구보다 먼저다.
    assert "값을 바꿔 맞추지 말 것" in r["reason"]


def test_period_mismatch_names_both_numbers():
    r = gg_finance.calculate(spec(life=19))
    assert r["status"] == "unsupported"
    assert "분석기간 5년과 주 투자 내용연수 19년이 다름" in r["reason"]
    # 걸리지도 않은 조건을 이유로 대지 않는다.
    assert "경영주 급여" not in r["reason"]
    assert "기존 사업 일부 투자" not in r["reason"]


def test_owner_salary_names_only_itself():
    r = gg_finance.calculate(spec(owner_labor_in_costs=True))
    assert r["status"] == "unsupported"
    assert "경영주 급여" in r["reason"]
    assert "내용연수" not in r["reason"]


def test_several_conditions_are_all_named():
    r = gg_finance.calculate(spec(life=19, owner_labor_in_costs=True))
    assert r["status"] == "unsupported"
    assert "경영주 급여" in r["reason"]
    assert "내용연수 19년" in r["reason"]


def test_a_supported_plan_gets_past_these_guards():
    """경계가 좁아지지 않았는지 — 지원 범위 안의 값은 이 사유로 막히지 않는다.

    기간 자료를 비워 두었으므로 더 뒤의 계산에서 걸리는 것이 정상이다. 거기까지
    갔다는 것 자체가 위 세 관문을 지났다는 뜻이다.
    """
    with pytest.raises(KeyError):
        gg_finance.calculate(spec())
