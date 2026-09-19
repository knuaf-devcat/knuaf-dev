"""gg_commands: the four legacy entrypoints (build_status·lint_evidence·
merge_sections·lint_format) that share one dispatcher.

Nothing in SKILL.md or the app references these any more — gg.py covers the
same ground — but lint_format keeps one capability gg.py does not have: it can
check a single section file in a folder that has no project.json yet. The rest
must refuse that folder rather than pass judgement on an unimported ledger.
"""
import json

import pytest

from conftest import run_script, write_section

SHIMS = {"build_status": "status", "lint_evidence": "evidence",
         "merge_sections": "merge", "lint_format": "format"}


def rows(result):
    return json.loads(result.stdout)


@pytest.fixture
def loose_sections(tmp_path):
    """A pre-project.json folder: sections on disk, no canon."""
    folder = tmp_path / "예전 작업"
    write_section(folder, "sections/01.md", "Ⅰ. 머리말", "농장A의 재배 면적은 600평이다.")
    return folder


# --- an unimported folder is refused, not judged ------------------------------

@pytest.mark.parametrize("shim", ["build_status", "lint_evidence", "merge_sections"])
def test_a_folder_without_a_canon_is_blocked(shim, loose_sections):
    """A legacy ledger must be imported before anything reports on it."""
    r = run_script(f"{shim}.py", loose_sections)
    assert r.returncode == 2, r.stdout
    body = rows(r)
    assert body[0]["status"] == "blocked"
    assert body[0]["check_id"] == "execution"
    assert "import" in body[0]["reason"]


def test_the_evidence_refusal_says_why_a_string_is_not_proof(loose_sections):
    r = run_script("lint_evidence.py", loose_sections)
    assert "검증 완료로 인정하지 않음" in rows(r)[0]["reason"]


# --- the one thing gg.py cannot do --------------------------------------------

def test_format_checks_a_single_file_without_a_project(loose_sections):
    """This is why the shim is kept; gg.py check needs a canon."""
    r = run_script("lint_format.py", loose_sections / "sections" / "01.md")
    assert r.returncode == 0, r.stdout
    body = rows(r)
    assert body[0]["check_id"] == "format"
    assert body[0]["status"] == "pass"


def test_a_clean_single_file_says_what_it_did_not_check(loose_sections):
    r = run_script("lint_format.py", loose_sections / "sections" / "01.md")
    assert "내용·렌더 별도" in rows(r)[0]["reason"], "검사 범위를 밝히지 않음"


def test_format_reports_a_real_defect_with_a_failing_exit_code(tmp_path):
    """H1 merge markers are the documented example of a text-level defect."""
    bad = tmp_path / "깨진.md"
    bad.write_text("# Ⅰ. 머리말\n\n<<<<<<< HEAD\n농장A\n=======\n농장B\n>>>>>>> x\n",
                   encoding="utf-8")
    r = run_script("lint_format.py", bad)
    assert r.returncode == 1, r.stdout
    body = rows(r)
    assert any(x["status"] != "pass" for x in body)


# --- the canon path -----------------------------------------------------------

def test_status_on_a_real_project_reports_the_revision_and_checks(project):
    r = run_script("build_status.py", project)
    assert r.returncode == 0, r.stderr
    data = json.loads(r.stdout)
    assert data["revision"] >= 1
    assert isinstance(data["checks"], list)
    assert isinstance(data["tasks"], list)


def test_merge_on_a_real_project_publishes_a_review_export(project):
    r = run_script("merge_sections.py", project)
    assert r.returncode == 0, r.stderr
    path = r.stdout.strip()
    assert path.endswith(".md")
    assert (project / "build").is_dir()


def test_evidence_on_a_real_project_returns_the_same_checks_as_gg_check(project):
    from conftest import parse_json, run_gg
    shim = rows(run_script("lint_evidence.py", project))
    direct = parse_json(run_gg(project, "check").stdout)
    assert [x["check_id"] for x in shim] == [x["check_id"] for x in direct]


# --- an empty target is not a pass --------------------------------------------

@pytest.mark.parametrize("make,label", [
    (lambda t: t / "없는폴더", "없는 경로"),
    (lambda t: _empty_sections(t), "빈 sections 폴더"),
    (lambda t: _empty_file(t), "빈 파일"),
])
def test_format_blocks_an_empty_target_instead_of_passing_it(make, label, tmp_path):
    """glob on a missing folder yields nothing, and an empty body used to sail
    through as '서식 통과' — a wrong path got a green light."""
    r = run_script("lint_format.py", make(tmp_path))
    assert r.returncode == 2, f"{label}: {r.stdout}"
    assert rows(r)[0]["status"] == "blocked"


def _empty_sections(t):
    (t / "빈폴더" / "sections").mkdir(parents=True)
    return t / "빈폴더"


def _empty_file(t):
    f = t / "빈파일.md"
    f.write_text("", encoding="utf-8")
    return f


# --- failures are reported, never raised --------------------------------------

@pytest.mark.parametrize("shim", sorted(SHIMS))
def test_a_missing_target_is_reported_as_json_not_a_traceback(shim, tmp_path):
    r = run_script(f"{shim}.py", tmp_path / "없는폴더")
    assert r.returncode == 2
    assert "Traceback" not in r.stderr
    body = rows(r)
    assert body[0]["status"] == "blocked"


@pytest.mark.parametrize("shim", sorted(SHIMS))
def test_every_shim_emits_parsable_json(shim, loose_sections):
    r = run_script(f"{shim}.py", loose_sections)
    json.loads(r.stdout)


# --- the shims stay thin ------------------------------------------------------

def test_each_shim_only_dispatches_into_the_one_adapter():
    """If a shim grows its own logic it becomes a second source of judgement."""
    from conftest import SCRIPTS
    for shim, mode in SHIMS.items():
        src = (SCRIPTS / f"{shim}.py").read_text(encoding="utf-8")
        assert "from gg_commands import main" in src, shim
        assert f'main("{mode}")' in src, f"{shim} should dispatch {mode!r}"
        body = [ln for ln in src.splitlines()
                if ln.strip() and not ln.startswith("#") and not ln.startswith('"""')]
        assert len(body) <= 5, f"{shim}이 얇은 어댑터가 아님: {len(body)}줄"
