"""apply()/validate() integrity: audit C3, H8."""
import json
from pathlib import Path

import pytest

import gg_core as core
from conftest import basic_change


def test_integer_id_is_rejected_before_save(project):
    change = {"request_id": "bad-id", "ops": [{"collection": "tasks", "value": {"id": 7, "title": "x"}}]}
    with pytest.raises(ValueError):
        core.apply(project, change, 1)
    # and the project must still load afterwards
    assert core.load(project)["revision"] == 1


def test_null_or_empty_id_is_rejected(project):
    for bad in (None, ""):
        change = {"request_id": "bad-id-" + str(bad), "ops": [{"collection": "tasks", "value": {"id": bad}}]}
        with pytest.raises(ValueError):
            core.apply(project, change, 1)
    assert core.load(project)["revision"] == 1


def test_apply_is_idempotent_per_request_id(project):
    before = core.load(project)
    after = core.apply(project, basic_change(), 99)  # wrong expected rev ignored on replay
    assert after["revision"] == before["revision"] == 1


def test_snapshot_written_per_apply(project):
    snap = project / "migration" / "revision-0.json"
    assert snap.exists()
    assert json.loads(snap.read_text(encoding="utf-8"))["revision"] == 0


def test_unknown_answer_is_asked_then_helped_then_deferred(project):
    p = core.load(project)
    assert core.question(p, "price.kg") == "ask"
    p["questions"]["price.kg"] = {"id": "price.kg", "field_id": "price.kg", "decision_revision": 1, "attempts": 1, "revision": 1}
    assert core.question(p, "price.kg") == "help"
    p["questions"]["price.kg"]["attempts"] = 2
    assert core.question(p, "price.kg") == "deferred"


def test_provided_answer_is_reused(project):
    assert core.question(core.load(project), "farm.area") == "reuse"


# --- 빈 내보내기는 성공이 아니다 -----------------------------------------------

def test_export_refuses_a_project_with_no_sections(empty_folder):
    """절이 하나도 없으면 merged() 가 빈 문자열을 돌려준다. 그대로 쓰면 0바이트
    파일이 생기고 호출자는 경로를 받아 "완료"로 읽는다 — 앱이 실제로 그렇게
    안내했다(GUI 감사 GUI-03). 하지 않은 일을 했다고 말하지 않는다."""
    core.init(empty_folder)
    with pytest.raises(ValueError, match="내보낼 본문이 없음"):
        core.export(empty_folder, "draft")
    assert not (empty_folder / "build").exists() or not list(
        (empty_folder / "build").rglob("*.md")
    )


def test_export_allows_a_titles_only_outline(project):
    """경계를 고정한다. 절은 있는데 초안이 비면 merged() 는 빈 문자열이 아니라
    제목만 돌려주므로(gg_core.py 의 merged) 위 가드에 걸리지 않는다.

    이건 놓친 게 아니라 정한 것이다. 감사가 지적한 것은 0바이트 파일이고,
    "검토전 초안"으로 뼈대만 내보내 보는 것은 있을 수 있는 일이라 막지 않는다.
    이 판단을 바꾸려면 이 테스트가 먼저 깨져야 한다."""
    from conftest import write_section

    for section in core.load(project)["sections"].values():
        write_section(project, section["path"], section["title"], "")
    path = core.export(project, "draft")
    text = Path(path).read_text(encoding="utf-8")
    assert text.strip()          # 0바이트는 아니고
    assert "머리말" in text       # 제목은 들어 있다


def test_export_still_works_with_real_content(project):
    """과잉 차단 방지 — 내용이 있으면 그대로 나가야 한다."""
    path = core.export(project, "draft")
    assert path.endswith(".md")
    assert Path(path).read_text(encoding="utf-8").strip()
