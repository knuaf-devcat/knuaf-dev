"""gg_deps.ensure: project-local venv that actually runs (symlinked interpreter), offline wheelhouse path."""
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
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
    assert pip_kw["env"]["PYTHONIOENCODING"] == "utf-8"  # 자식은 UTF-8 로 말한다
    assert pip_kw["encoding"] == "utf-8"  # 부모도 같은 인코딩으로 읽어야 한다(W2-ENC-R1-01)
    assert pip_kw["errors"] == "replace"  # 해독 실패가 pip 결과를 뒤집지 않게
    assert pip_kw["env"].get("PATH") == os.environ.get("PATH")  # 나머지 환경은 그대로 물려준다
    assert result["pip_exit"] == 0


def _locale_decoding_subprocess(codec):
    """`text=True` 에 encoding 을 주지 않은 호출을, 그 로케일로 해독하는 대역으로 만든다.

    파이썬 3.10 에는 `subprocess._text_encoding`(3.11 이상에만 있는 사설 함수)이 없어 그것을
    패치할 수 없다. 대신 제품 코드가 **로케일에 맡긴** 경우(encoding 을 지정하지 않았을 때)만
    그 로케일 인코딩을 끼워 넣어 실제 cp1252·cp949 부모와 같은 조건을 만든다 — 3.10·3.11+ 에서
    같은 방식으로 동작하고, 검사력도 그대로다(제품 코드가 encoding 을 지키면 아무것도 바꾸지
    않으므로 통과, 지우면 로케일 해독으로 되돌아가 실패).
    """
    real_run = subprocess.run

    def run(cmd, **kw):
        if "encoding" not in kw and kw.get("text"):
            kw["encoding"] = codec
        return real_run(cmd, **kw)

    return SimpleNamespace(run=run, SubprocessError=subprocess.SubprocessError)


def test_ensure_survives_non_utf8_parent_decoding(tmp_path, monkeypatch):
    """검토 W2-ENC-R1-01: 부모가 로케일(cp1252·cp949)로 읽어도 준비가 깨지면 안 된다.

    실제 pip 자식을 돌린다 — 빈 ASCII 요구 파일 + 빈 한글 wheelhouse + `--no-index` 라
    설치·다운로드가 없다(`Looking in links: <한글 경로>` 가 나온다). 부모 쪽 해독기만
    `gg_deps` 안의 `subprocess.run` 대역으로 바꾼다(macOS 에서는 cp1252·cp949 로케일을 만들 수
    없다). 대역으로 kwargs 만 보는 시험은 이 바이트 해독 문제를 잡지 못하므로 실제 자식을 돌린다.
    """
    import gg_deps

    root = tmp_path / "홍길동 논문"
    wheels = root / "휠 모음"
    wheels.mkdir(parents=True)
    req = root / "requirements-empty.txt"
    req.write_text("# empty offline probe\n", encoding="ascii")

    monkeypatch.setattr(gg_deps, "REQUIREMENTS", req)
    monkeypatch.setattr(gg_deps, "load_manifest", lambda *a, **k: [])
    monkeypatch.setattr(gg_deps, "venv_python", lambda *a, **k: Path(sys.executable))

    for codec in ("utf-8", "cp1252", "cp949"):
        monkeypatch.setattr(gg_deps, "subprocess", _locale_decoding_subprocess(codec))
        out = io.StringIO()
        with redirect_stdout(out):
            code = gg_deps.main(["ensure", str(root), "--no-index", "--find-links", str(wheels)])
        data = json.loads(out.getvalue())
        assert code == 0, (codec, data)
        assert data["pip_exit"] == 0, (codec, data)
        # pip 의 실제 진단(한글 경로)이 깨지지 않고 남는다.
        assert "휠 모음" in data["pip_stdout_tail"] + data["pip_stderr_tail"], (codec, data)
