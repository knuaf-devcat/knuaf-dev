"""Baseline CLI behaviour that must keep working while we fix the audit items."""
import json
import sys

import pytest

from conftest import parse_json, run_gg

WIN_LOCK = pytest.mark.xfail(
    sys.platform == "win32", reason="audit C1: Lock uses O_DIRECTORY/dir_fd (Unix only)", strict=True
)


@WIN_LOCK
def test_init_status_next_check_flow(project):
    st = run_gg(project, "status")
    assert st.returncode == 0, st.stderr
    data = parse_json(st.stdout)
    assert data["revision"] == 1
    assert {"checks", "tasks", "completion", "skill_ready"} <= set(data)
    nx = run_gg(project, "next")
    assert nx.returncode == 0 and isinstance(parse_json(nx.stdout), list)
    ck = run_gg(project, "check")
    assert ck.returncode in (0, 1), ck.stderr  # 1 = failing checks, still JSON
    assert isinstance(parse_json(ck.stdout), list)


@WIN_LOCK
def test_export_draft_creates_versioned_folder(project):
    ex = run_gg(project, "export", "--kind", "draft")
    assert ex.returncode == 0, ex.stdout + ex.stderr
    path = parse_json(ex.stdout)["path"]
    assert "/build/1/draft/" in path.replace("\\", "/")
    assert (project / "build" / "1" / "draft" / "manifest.json").exists()


def test_doctor_reports_lock_and_orphans(project):
    dr = run_gg(project, "doctor")
    assert dr.returncode == 0
    data = parse_json(dr.stdout)
    assert "orphan_files" in data
    assert data["model_calls"] == "disabled"


@WIN_LOCK
def test_wrong_expected_revision_is_blocked_json(project, tmp_path):
    change = tmp_path / "c.json"
    change.write_text(json.dumps({"request_id": "x", "ops": []}), encoding="utf-8")
    r = run_gg(project, "apply", "--change", change, "--expected-revision", "7")
    assert r.returncode == 2
    assert parse_json(r.stdout)["status"] == "blocked"


def test_malformed_source_claims_yields_blocked_json_not_traceback(project):
    """A source whose `claims` is a list must produce {"status": "blocked"}, not a traceback."""
    pj = project / "project.json"
    p = json.loads(pj.read_text(encoding="utf-8"))
    p["sources"]["src-answers"]["claims"] = []
    pj.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
    r = run_gg(project, "check")
    assert r.returncode in (1, 2), r.stderr
    out = parse_json(r.stdout)
    if isinstance(out, dict):
        assert out["status"] == "blocked"
    else:
        assert any(row["check_id"] == "source_claims_invalid" for row in out)
