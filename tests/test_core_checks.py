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
