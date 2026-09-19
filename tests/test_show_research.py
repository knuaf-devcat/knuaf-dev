"""show_research reads the canon (project.json), not the retired flat-file ledger."""
from conftest import run_script


def run_show(folder, *args):
    return run_script("show_research.py", folder, *args)


def test_lists_facts_from_canon(project):
    r = run_show(project)
    assert r.returncode == 0, r.stderr
    assert "사실 2" in r.stdout
    assert "fact-area" in r.stdout and "farm.area" in r.stdout
    # An unverified fact must be marked, not quietly listed as evidence.
    assert "미검증 2건" in r.stdout


def test_claim_lookup_is_comma_insensitive(project):
    r = run_show(project, "--claim", "6,00")
    assert r.returncode == 0, r.stderr
    assert "fact-area" in r.stdout
    assert "src-answers" in r.stdout and "L3" in r.stdout


def test_missing_claim_says_no_basis(project):
    r = run_show(project, "--claim", "99999")
    assert r.returncode == 0
    assert "근거 없는 수치" in r.stdout


def test_source_id_lists_citing_facts(project):
    r = run_show(project, "--id", "src-answers")
    assert r.returncode == 0, r.stderr
    assert "이 출처를 쓰는 사실 2건" in r.stdout
    # The unanswered fact keeps its state and is not rendered as a value.
    assert "unknown" in r.stdout


def test_unknown_source_is_reported_not_raised(project):
    r = run_show(project, "--id", "nope")
    assert r.returncode == 0
    assert "정본에 없다" in r.stdout


def test_folder_without_canon_is_blocked_not_empty(empty_folder):
    """The old version printed '0건' here, which read as 'no evidence exists'."""
    r = run_show(empty_folder)
    assert r.returncode == 2
    assert "정본을 읽을 수 없음" in r.stdout
    assert "import" in r.stdout
