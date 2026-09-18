"""apply()/validate() integrity: audit C3, H8."""
import json

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
