"""Baseline CLI behaviour that must keep working while we fix the audit items."""
import json


from conftest import parse_json, run_gg


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


def test_init_creates_documented_layout(empty_folder):
    """section-ledger.md lists these; before, they existed only in prose."""
    assert run_gg(empty_folder, "init").returncode == 0
    for rel in ("sources", "sources/extracts", "audit/model-routing"):
        assert (empty_folder / rel).is_dir(), rel


def test_init_works_in_a_folder_that_already_holds_the_students_files(empty_folder):
    """SKILL.md:30 tells the model to init in the folder the student picked.

    The app opens one folder and then reads `<root>/project.json`; if the model
    digs a sub-folder because the picked one is not empty, the app shows an empty
    project forever and never says why. That instruction is only safe because
    init refuses on an existing canon and otherwise touches nothing else.
    """
    keep = empty_folder / "모스틱팜_영농창업계획.hwp"
    keep.write_bytes(b"\xd0\xcf\x11\xe0 hwp")
    (empty_folder / "_참고자료").mkdir()
    before = keep.read_bytes()

    assert run_gg(empty_folder, "init").returncode == 0
    assert (empty_folder / "project.json").is_file(), "지정한 폴더에 정본이 생기지 않음"
    assert keep.read_bytes() == before, "학생 원본이 바뀜"
    assert (empty_folder / "_참고자료").is_dir(), "학생 폴더가 사라짐"

    again = run_gg(empty_folder, "init")
    assert again.returncode != 0, "기존 정본을 덮어씀"


def test_paper_runs_from_the_project_dir(project, tmp_path):
    """Bisects the sidecar's paper.generate hang on Windows.

    The sidecar runs `gg.py paper` with cwd set to the project (a Korean-named
    folder), not to scripts/. If this passes where the sidecar call times out,
    the fault is in the sidecar's runner rather than in gg.py itself.
    """
    (project / "paper.json").write_text(
        '{"title": "T", "writing_year": 2026}', encoding="utf-8"
    )
    r = run_gg(project, "paper", "--input", "paper.json", "--out", "build/본문.md",
               cwd=project, timeout=60)
    assert r.returncode == 0, "stdout=%r stderr=%r" % (r.stdout, r.stderr)
    assert (project / "build" / "본문.md").is_file()
