"""checks(): audit H9 (unit filter), malformed claims/views guards, legacy xlsx detection."""
import json

import gg_core as core
import gg_school_excel
from conftest import parse_json, run_gg


def _add_fact(project, fid, unit, value="12000"):
    change = {
        "request_id": "fact:" + fid,
        "ops": [{"collection": "facts", "value": {
            "id": fid, "field_id": fid, "kind": "reported_fact", "value": value, "unit": unit,
            "value_type": "decimal", "period": "2027", "scope": "농장A",
            "answer_state": "provided", "verification": "unreviewed",
            "source_refs": [{"id": "src-answers", "revision": 1, "locator": "L3"}],
        }}],
    }
    core.apply(project, change, core.load(project)["revision"])


def test_money_fact_in_won_is_blocked_not_ignored(project):
    _add_fact(project, "price.kg", "원/kg")
    p = core.load(project)
    rows = [r for r in core.checks(project, p) if r["check_id"] == "body_finance_crosscheck"]
    assert any(r["target"] == "price.kg" and r["status"] == "blocked" and "미지원 단위" in r["reason"] for r in rows)


# 시험주행 발견 20 — 본문 대조는 사실의 field_id 를 본문에서 찾아 그 옆의 숫자를 본다.
# 도우미가 field_id 를 `finance.own_capital` 같은 기계용 식별자로 두면 본문에 있을 수가
# 없는데, 앱은 그것을 "본문에 재무 항목 없음"이라는 실패로 세었다. 자기자본이 본문에
# 분명히 적혀 있는데도 36건이 그렇게 "고칠 곳"에 쌓였다. 앱이 확인하지 못한 것을 본문의
# 잘못으로 돌린 것이라, 실패가 아니라 보류여야 한다.
def test_machine_field_id_is_blocked_not_blamed_on_the_body(project):
    _add_fact(project, "finance.own_capital", "천원", value="65000")
    p = core.load(project)
    rows = [r for r in core.checks(project, p) if r["check_id"] == "body_finance_crosscheck"]
    row = next(r for r in rows if r["target"] == "finance.own_capital")
    assert row["status"] == "blocked", row
    assert "기계용 식별자" in row["reason"]
    assert "본문에 재무 항목 없음" not in row["reason"]
    # 보류도 제출 관문은 그대로 막는다 — 통과로 바꾸는 수정이 아니다.
    assert core.blocks_skill_candidate(row)


# 반대쪽. 사람이 쓰는 이름인데 본문에 없으면 그건 정말 본문의 문제다 — 보류로 덮지 않는다.
def test_a_real_missing_term_stays_a_failure(project):
    _add_fact(project, "매출액", "천원", value="144000")
    p = core.load(project)
    rows = [r for r in core.checks(project, p) if r["check_id"] == "body_finance_crosscheck"]
    row = next(r for r in rows if r["target"] == "매출액")
    assert row["status"] == "fail", row
    assert row["reason"] == "본문에 재무 항목 없음"


def _add_derived(project, fid, op, inputs, value, unit_reason="입력·결과 모두 천원"):
    formula = {"op": op}
    if unit_reason:
        formula["unit_reason"] = unit_reason
    change = {
        "request_id": "derived:" + fid,
        "ops": [{"collection": "facts", "value": {
            "id": fid, "field_id": fid, "kind": "derived", "value": value, "unit": "천원",
            "value_type": "decimal", "period": "2027", "scope": "농장A",
            "answer_state": "provided", "verification": "unreviewed",
            "source_refs": [{"id": "src-answers", "revision": 1, "locator": "L3"}],
            "formula": formula,
            "input_refs": [{"id": i, "revision": 1} for i in inputs],
        }}],
    }
    core.apply(project, change, core.load(project)["revision"])


def _calc_rows(project):
    p = core.load(project)
    return [r for r in core.checks(project, p) if r["check_id"] == "calculation"]


# 시험주행 발견 — 검산은 피연산자가 정확히 2개인 사칙연산만 받았다. 그런데 논문에 실제로
# 필요한 것은 경영비 10개 항목의 합 같은 것이다. 항 수만 늘어난 같은 종류의 검산이므로
# 검사기가 하는 일은 두 항일 때와 다르지 않다 — 틀린 계산이 숨을 자리가 늘지 않는다.
def test_n_ary_sum_is_verified(project):
    for i in range(10):
        _add_fact(project, "경영비%d" % i, "천원", value="1000")
    _add_derived(project, "경영비합계", "add", ["경영비%d" % i for i in range(10)], "10000")
    assert not [r for r in _calc_rows(project) if r["target"] == "경영비합계"], _calc_rows(project)


def test_n_ary_product_is_verified(project):
    for name, v in (("단수", "500"), ("면적", "600"), ("포장비율", "2")):
        _add_fact(project, name, "천원", value=v)
    _add_derived(project, "총생산량", "multiply", ["단수", "면적", "포장비율"], "600000")
    assert not [r for r in _calc_rows(project) if r["target"] == "총생산량"], _calc_rows(project)


# 넓힌 쪽이 무르면 안 된다. 항이 열 개라도 값이 안 맞으면 그건 진짜 계산 오류다.
def test_a_wrong_n_ary_sum_stays_a_failure(project):
    for i in range(10):
        _add_fact(project, "경영비%d" % i, "천원", value="1000")
    _add_derived(project, "경영비합계", "add", ["경영비%d" % i for i in range(10)], "9999")
    row = next(r for r in _calc_rows(project) if r["target"] == "경영비합계")
    assert row["status"] == "fail", row
    assert row["reason"] == "계산 결과 불일치"


# 도구가 표현하지 못하는 산식을 "이항 산식 필요"라는 실패로 세면, 앱이 확인하지 못한 것을
# 데이터의 잘못으로 돌리는 것이다. 실제 주행에서 23건이 그렇게 쌓였고 도우미는 통과시키려고
# 논문에 없는 중간 항목 30개를 만들어야 한다고 했다. 확인 불가는 실패가 아니라 보류다.
def test_formulas_the_tool_cannot_express_are_blocked_not_blamed(project):
    for name in ("단수", "면적", "환산계수"):
        _add_fact(project, name, "천원", value="100")
    _add_derived(project, "삼항나눗셈", "divide", ["단수", "면적", "환산계수"], "1")
    _add_derived(project, "원리금균등상환액", "pmt", ["단수", "면적"], "1")
    rows = {r["target"]: r for r in _calc_rows(project)}

    three_way = rows["삼항나눗셈"]
    assert three_way["status"] == "blocked", three_way
    # 무엇이 되고 무엇이 안 되는지를 사실대로 적는다.
    assert "두 항 나눗셈·뺄셈과 두 항 이상 덧셈·곱셈만 검산할 수 있음" in three_way["reason"]
    assert "피연산자 3개" in three_way["reason"]

    pmt = rows["원리금균등상환액"]
    assert pmt["status"] == "blocked", pmt
    assert "미지원 연산 'pmt'" in pmt["reason"]


# 보류로 바꾼 것이 통과로 바꾼 것은 아니다 — severity 는 error 그대로라 제출 관문은 막힌다.
def test_a_blocked_formula_still_blocks_the_submission_gate(project):
    for name in ("단수", "면적", "환산계수"):
        _add_fact(project, name, "천원", value="100")
    _add_derived(project, "삼항나눗셈", "divide", ["단수", "면적", "환산계수"], "1")
    row = next(r for r in _calc_rows(project) if r["target"] == "삼항나눗셈")
    assert row["severity"] == "error", row
    assert core.blocks_skill_candidate(row)


# 단위 근거 같은 데이터 쪽 조건은 그대로 실패다. 보류로 덮지 않는다.
def test_missing_unit_reason_stays_a_failure(project):
    for i in range(3):
        _add_fact(project, "항목%d" % i, "천원", value="1000")
    _add_derived(project, "합계", "add", ["항목0", "항목1", "항목2"], "3000", unit_reason=None)
    row = next(r for r in _calc_rows(project) if r["target"] == "합계")
    assert row["status"] == "fail", row
    assert row["reason"] == "단위 근거 필요"


def test_non_money_fact_is_not_flagged(project):
    p = core.load(project)  # fixture has 면적 600평
    rows = [r for r in core.checks(project, p) if r["check_id"] == "body_finance_crosscheck"]
    assert not any(r["target"] == "fact-area" for r in rows)


def test_malformed_claims_and_views_become_blocked_rows(project):
    pj = project / "project.json"
    p = json.loads(pj.read_text(encoding="utf-8"))
    p["sources"]["src-answers"]["claims"] = []
    p["views"] = ["oops"]
    pj.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    r = run_gg(project, "check")
    assert r.returncode == 1, r.stdout + r.stderr
    ids = {row["check_id"] for row in parse_json(r.stdout)}
    assert {"source_claims_invalid", "view_invalid"} <= ids


def test_legacy_school_layout_detection():
    full = list(gg_school_excel.SCHOOL_SHEETS)
    assert gg_school_excel._legacy_school_layout(full)
    assert not gg_school_excel._legacy_school_layout(["목록", "내 계획"])
    assert not gg_school_excel._legacy_school_layout(full[:1] + ["x"] * 16)
    assert gg_school_excel._legacy_school_layout(full[:12] + ["x"] * 5)
