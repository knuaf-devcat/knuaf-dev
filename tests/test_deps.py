"""gg_deps.ensure: project-local venv that actually runs (symlinked interpreter), offline wheelhouse path."""
import os
import subprocess

import pytest

from conftest import REPO, parse_json, run_script

WHEELHOUSE = REPO / "app" / "resources" / "wheelhouse"
# the wheelhouse is built for the bundled runtime (lxml is cp312-specific), so use that interpreter
BUNDLED = REPO / "app" / "resources" / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
needs_wheels = pytest.mark.skipif(
    not (WHEELHOUSE.is_dir() and BUNDLED.exists()), reason="no bundled runtime + wheelhouse (pnpm fetch:python && pnpm build:wheelhouse)"
)


@needs_wheels
def test_ensure_offline_creates_working_venv(empty_folder):
    r = run_script("gg_deps.py", "ensure", empty_folder, "--no-index", "--find-links", WHEELHOUSE, python=str(BUNDLED), timeout=600)
    assert r.returncode == 0, r.stdout + r.stderr
    data = parse_json(r.stdout)
    assert data["status"] == "installed" and data["created"] is True
    vpy = data["venv_python"]
    if os.name != "nt":
        assert os.path.islink(vpy) or os.path.islink(os.path.join(os.path.dirname(vpy), "python"))
    probe = subprocess.run([vpy, "-c", "import openpyxl, docx, pypdf; print('ok')"], capture_output=True, text=True)
    assert probe.stdout.strip() == "ok", probe.stderr
    d = parse_json(run_script("gg_deps.py", "doctor", empty_folder, python=str(BUNDLED)).stdout)
    assert d["ready"] is True and d["venv_python"] == vpy


def test_ensure_failure_is_json_not_traceback(empty_folder, monkeypatch):
    """A failing pip/venv step must surface as {"status": ...}, never a traceback."""
    r = run_script("gg_deps.py", "ensure", empty_folder, "--no-index", "--find-links", str(empty_folder / "nowhere"), timeout=600)
    assert r.returncode in (1, 2), r.stderr
    data = parse_json(r.stdout)
    assert data["status"] in ("failed", "blocked")
    assert "Traceback" not in r.stderr
