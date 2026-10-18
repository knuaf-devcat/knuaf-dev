"""gg_deps.ensure: project-local venv that actually runs (symlinked interpreter), offline wheelhouse path."""
import os
import subprocess
from types import SimpleNamespace

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


def test_pip_requirement_files_are_ascii():
    """pip 은 -r 파일을 **로케일 인코딩**으로 읽는다 — 비ASCII 한 바이트로 설치가 깨진다.

    W2 윈도우 설치본 빌드가 정확히 이렇게 실패했다(cp1252 → UnicodeDecodeError).
    한국어 Windows(cp949)에서 학생 PC도 같은 원인으로 깨진다.
    """
    skip_parts = {"node_modules", "__pycache__", "test-results", "dist", "out", "resources", "site-packages"}
    files = []
    for p in REPO.rglob("requirements*.txt"):
        parts = p.relative_to(REPO).parts[:-1]
        if any(part.startswith(".") for part in parts) or any(part in skip_parts for part in parts):
            continue
        files.append(p)
    assert files, "검사할 pip 요구 파일을 찾지 못함"
    for p in files:
        raw = p.read_bytes()
        try:
            raw.decode("ascii")
        except UnicodeDecodeError as e:
            line = raw[: e.start].count(b"\n") + 1
            raise AssertionError(
                f"{p.relative_to(REPO)}:{line} 에 비ASCII 바이트가 있다. pip 이 로케일 인코딩으로 읽어 "
                "한국어 Windows(cp949)·서구 Windows(cp1252)에서 UnicodeDecodeError 로 실패한다."
            ) from None


def test_ensure_hands_pip_utf8_env(empty_folder, monkeypatch):
    """pip 자식에게 PYTHONUTF8=1 을 넘겨 -r 파일을 로케일과 무관하게 읽게 한다.

    실제 pip 은 돌리지 않는다 — subprocess.run 만 대역으로 바꿔 넘긴 환경을 본다.
    """
    import gg_deps

    vpy = empty_folder / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python3")
    vpy.parent.mkdir(parents=True)
    vpy.write_text("")  # venv_python 은 존재만 보므로 venv 를 만들지 않고 이 파일로 대신한다

    calls = []

    class _Proc:
        returncode = 0
        stdout = "1.0\n"
        stderr = ""

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))
        return _Proc()

    shim = SimpleNamespace(run=fake_run, SubprocessError=subprocess.SubprocessError)
    monkeypatch.setattr(gg_deps, "subprocess", shim)
    result, _ = gg_deps.ensure(empty_folder, no_index=True, find_links=empty_folder)

    pip_cmd, pip_kw = calls[0]  # 첫 호출이 pip 설치다
    assert pip_cmd[:3] == [str(vpy), "-m", "pip"]
    assert "--requirement" in pip_cmd and str(gg_deps.REQUIREMENTS) in pip_cmd
    assert pip_kw["env"]["PYTHONUTF8"] == "1"
    assert pip_kw["env"].get("PATH") == os.environ.get("PATH")  # 나머지 환경은 그대로 물려준다
    assert result["pip_exit"] == 0
