"""audit H10 + GUI prerequisite: lineage (project_id/parent_hash), history, restore."""
import json
import sys

import pytest

import gg_core as core
from conftest import parse_json, run_gg

WIN_LOCK = pytest.mark.xfail(sys.platform == "win32", reason="audit C1", strict=True)


@WIN_LOCK
def test_init_assigns_project_id_and_apply_records_parent_hash(project):
    p = core.load(project)
    assert len(p["project_id"]) == 32
    assert p["parent_hash"] == p["history"][-1]["hash"]


@WIN_LOCK
def test_tampered_parent_hash_is_rejected_on_load(project):
    pj = project / "project.json"
    p = json.loads(pj.read_text(encoding="utf-8"))
    p["parent_hash"] = "0" * 64
    pj.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="계보"):
        core.load(project)


def test_legacy_project_without_parent_hash_still_loads(project):
    pj = project / "project.json"
    p = json.loads(pj.read_text(encoding="utf-8"))
    del p["parent_hash"]
    del p["project_id"]
    pj.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    assert core.load(project)["revision"] == 1


@WIN_LOCK
def test_history_lists_snapshots_and_current(project):
    r = run_gg(project, "history")
    assert r.returncode == 0, r.stdout + r.stderr
    hist = parse_json(r.stdout)
    assert hist[0]["revision"] == 0 and hist[0]["snapshot_ok"] is True
    assert hist[-1]["current"] is True and hist[-1]["revision"] == 1


@WIN_LOCK
def test_restore_creates_new_revision_and_preserves_current_snapshot(project):
    r = run_gg(project, "restore", "--revision", "0", "--expected-revision", "1")
    assert r.returncode == 0, r.stdout + r.stderr
    out = parse_json(r.stdout)
    assert out["revision"] == 2 and out["restored_from"] == 0
    p = core.load(project)
    assert p["revision"] == 2 and p["sections"] == {} and p["facts"] == {}
    assert (project / "migration" / "revision-1.json").exists()
    assert [h["revision"] for h in p["history"]] == [0, 1]
    # the section file itself is untouched
    assert (project / "sections" / "01.md").exists()
    # and we can go forward again
    r2 = run_gg(project, "restore", "--revision", "1", "--expected-revision", "2")
    assert r2.returncode == 0, r2.stdout + r2.stderr
    assert core.load(project)["sections"]["sec-01"]["title"] == "Ⅰ. 머리말"


@WIN_LOCK
def test_restore_refuses_tampered_snapshot(project):
    snap = project / "migration" / "revision-0.json"
    data = json.loads(snap.read_text(encoding="utf-8"))
    data["issues"] = ["tampered"]
    snap.write_text(json.dumps(data), encoding="utf-8")
    r = run_gg(project, "restore", "--revision", "0", "--expected-revision", "1")
    assert r.returncode == 2
    assert "해시" in parse_json(r.stdout)["reason"]


@WIN_LOCK
def test_restore_refuses_stale_expected_revision_and_held_lock(project):
    r = run_gg(project, "restore", "--revision", "0", "--expected-revision", "5")
    assert r.returncode == 2 and "개정" in parse_json(r.stdout)["reason"]
    with core.Lock(project):
        r = run_gg(project, "restore", "--revision", "0", "--expected-revision", "1")
        assert r.returncode == 2 and "잠금" in parse_json(r.stdout)["reason"]
