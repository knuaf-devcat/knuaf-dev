"""audit C5: Python 3.9 must get a friendly guard, and gg_office must import on 3.10+."""
import pytest

from conftest import SCRIPTS, parse_json, python39, run_gg, run_script

py39 = python39()
needs39 = pytest.mark.skipif(py39 is None, reason="no Python 3.9 interpreter reachable (set PY39)")


@needs39
def test_gg_refuses_python39_with_json_notice(project):
    r = run_gg(project, "status", python=py39)
    assert r.returncode == 2
    data = parse_json(r.stdout)
    assert data["status"] == "blocked"
    assert "3.10" in data["reason"]


@needs39
def test_gg_office_imports_on_python39():
    r = run_script("gg_office.py", "doctor", python=py39)
    # after the fix the version guard answers; before it, import dies with TypeError
    assert "TypeError" not in r.stderr


def test_gg_office_imports_on_current_python():
    import importlib
    importlib.import_module("gg_office")
    importlib.import_module("gg_office_win")
