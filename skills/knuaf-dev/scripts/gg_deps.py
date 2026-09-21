#!/usr/bin/env python3
"""선언된 runtime 의존성: 정직한 doctor + 프로젝트 전용 venv 준비.

The package declares third-party requirements in requirements-runtime.txt /
runtime-deps.json next to this file. `doctor` reports per-dependency import
and declared version-range truth for BOTH the invoking interpreter (in-process
import, so -S/isolated envs are measured honestly) and the project venv
(<작업폴더>/.venv, checked through its own interpreter). It never treats
"installed somewhere else" as usable. `ensure` creates the project venv with
the stdlib venv module and installs the manifest with pip, then proves each
dependency by actually importing it in the venv interpreter. Failures are
reported, never faked. Nothing is copied from any HOME site-packages.
"""

import argparse
import importlib
import importlib.metadata
import os
import json
import re
import subprocess
import sys
import venv
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEPS_JSON = HERE / "runtime-deps.json"
REQUIREMENTS = HERE / "requirements-runtime.txt"

_DIST = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_SPEC = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9._*-]*[ ]*(?:[<>!=~]+[ ]*[A-Za-z0-9._*]+[ ]*,?[ ]*)+"
)
_IDENT_PATH = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
_OPS = (">=", "<=", "==", "!=", ">", "<")

# Runs inside another interpreter: argv, not string interpolation, so the
# declared module/dist names can never inject code.
_PROBE = (
    "import sys, importlib, importlib.metadata as m\n"
    "importlib.import_module(sys.argv[1])\n"
    "try:\n    print(m.version(sys.argv[2]))\n"
    "except m.PackageNotFoundError:\n    print('')\n"
)


def load_manifest(path=DEPS_JSON):
    path = Path(path)
    if not path.is_file():
        raise ValueError("runtime-deps.json 선언 없음: " + str(path))
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("runtime-deps.json 최상위는 객체여야 함")
    return validate_dependencies(data.get("dependencies"))


def validate_dependencies(deps):
    if not isinstance(deps, list) or not deps:
        raise ValueError("runtime-deps.json dependencies 비어 있음")
    out = []
    for d in deps:
        if not isinstance(d, dict):
            raise ValueError("dependency 항목이 객체가 아님")
        dist, spec, imp = d.get("dist"), d.get("spec"), d.get("import_name")
        purpose = d.get("purpose")
        if (
            not isinstance(dist, str)
            or not _DIST.fullmatch(dist)
            or not isinstance(spec, str)
            or not _SPEC.fullmatch(spec)
            or not spec.startswith(dist)
            or not isinstance(imp, str)
            or not _IDENT_PATH.fullmatch(imp)
            or not isinstance(purpose, str)
            or not purpose.strip()
        ):
            raise ValueError("dependency 선언 형식 오류: " + repr(d))
        used_by = d.get("used_by", [])
        if not isinstance(used_by, list) or not all(
            isinstance(u, str) for u in used_by
        ):
            raise ValueError("dependency used_by 형식 오류: " + repr(d))
        platform = d.get("platform")
        if platform is not None and (
            not isinstance(platform, str) or not re.fullmatch(r"[a-z0-9_]+", platform)
        ):
            raise ValueError("dependency platform 형식 오류: " + repr(d))
        out.append(d)
    return out


def _applicable(d):
    """True unless the dependency declares a platform this host is not.

    A dependency with no "platform" key applies everywhere (existing
    behavior, unchanged). One declaring e.g. "platform": "win32" is skipped
    entirely on other hosts rather than ever being reported "missing" —
    that would be a false alarm, not an honest readiness signal.
    """
    plat = d.get("platform")
    return plat is None or plat == sys.platform


def venv_python(project):
    project = Path(project)
    for cand in (
        project / ".venv" / "bin" / "python3",
        project / ".venv" / "bin" / "python",
        project / ".venv" / "Scripts" / "python.exe",
    ):
        if cand.is_file():
            return cand
    return None


def _version_tuple(text):
    # Stable dotted-numeric versions only; prereleases/junk suffixes are not
    # comparable -> None (installed-version-unchecked), never a false pass.
    if not re.fullmatch(r"\d+(?:\.\d+)*", (text or "").strip()):
        return None
    return tuple(int(x) for x in text.strip().split("."))


def _cmp(a, b):
    n = max(len(a), len(b))
    a, b = a + (0,) * (n - len(a)), b + (0,) * (n - len(b))
    return (a > b) - (a < b)


def spec_satisfied(version, spec, dist):
    """True/False when the version is known and comparable, else None.

    Supports >=, <=, >, <, ==, != on dotted numeric versions and == with a
    trailing .*
    """
    if version is None:
        return None
    vt = _version_tuple(version)
    if vt is None or not spec.startswith(dist):
        return None
    for clause in spec[len(dist):].split(","):
        clause = clause.strip()
        if not clause:
            continue
        op = next((o for o in _OPS if clause.startswith(o)), None)
        if op is None:
            return None
        want = clause[len(op):].strip()
        wt = _version_tuple(want[:-2] if want.endswith(".*") else want)
        if wt is None:
            return None
        if want.endswith(".*"):
            if op != "==":
                return None
            if vt[: len(wt)] != wt:
                return False
            continue
        c = _cmp(vt, wt)
        ok = {
            ">=": c >= 0,
            ">": c > 0,
            "<=": c <= 0,
            "<": c < 0,
            "==": c == 0,
            "!=": c != 0,
        }[op]
        if not ok:
            return False
    return True


def _import_and_version_current(module, dist):
    """Actual in-process import + dist metadata of THIS interpreter."""
    if not _IDENT_PATH.fullmatch(module):
        raise ValueError("import 이름 형식 오류: " + repr(module))
    try:
        importlib.import_module(module)
    except Exception:
        return False, None
    try:
        return True, importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return True, None


def _import_and_version(python, module, dist):
    """Import + dist version checked inside the given interpreter."""
    if not _IDENT_PATH.fullmatch(module) or not _DIST.fullmatch(dist):
        raise ValueError("import/dist 이름 형식 오류")
    proc = subprocess.run(
        [str(python), "-c", _PROBE, module, dist],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        return False, None
    version = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""
    return True, (version or None)


def _probe_row(d, imported, version):
    """One interpreter's truth for one declared dependency."""
    satisfied = spec_satisfied(version, d["spec"], d["dist"]) if imported else None
    if not imported:
        status = "missing"
    elif satisfied is False:
        status = "unsupported-version"
    elif satisfied is None:
        status = "installed-version-unchecked"
    else:
        status = "installed"
    return {
        "imported": imported,
        "version": version,
        "version_in_range": satisfied,
        "status": status,
    }


def _check_venv_dir(venv_dir):
    if venv_dir.is_symlink():
        raise ValueError("프로젝트 .venv가 symlink면 준비를 거부함: " + str(venv_dir))
    if venv_dir.exists() and not venv_dir.is_dir():
        raise ValueError(".venv 경로가 디렉터리가 아님: " + str(venv_dir))


def doctor(project):
    deps = load_manifest()
    project = Path(project)
    vpy = venv_python(project)
    selected = str(vpy) if vpy else sys.executable
    rows = []
    for d in deps:
        if not _applicable(d):
            continue
        cur = _import_and_version_current(d["import_name"], d["dist"])
        ven = (
            _import_and_version(vpy, d["import_name"], d["dist"])
            if vpy
            else None
        )
        current = _probe_row(d, *cur)
        venv_row = _probe_row(d, *ven) if ven else None
        rows.append(
            {
                "dist": d["dist"],
                "spec": d["spec"],
                "import_name": d["import_name"],
                "purpose": d["purpose"],
                "current": current,
                "venv": venv_row,
                "status": (venv_row or current)["status"],
            }
        )
    ready = all(r["status"] == "installed" for r in rows)
    return {
        "manifest": str(DEPS_JSON),
        "requirements": str(REQUIREMENTS),
        "project": str(project),
        "current_python": sys.executable,
        "venv_python": str(vpy) if vpy else None,
        "selected_python": selected,
        "ready": ready,
        "dependencies": rows,
        "notice": "다른 환경의 site-packages에 있어도 이 프로젝트의 실행 인터프리터에서 import·버전 범위가 확인되지 않으면 준비로 보지 않는다.",
    }


def ensure(project, find_links=None, no_index=False):
    deps = load_manifest()
    project = Path(project)
    venv_dir = project / ".venv"
    _check_venv_dir(venv_dir)
    vpy = venv_python(project)
    created = False
    if not vpy:
        # symlinks like `python -m venv` does on POSIX: a copied interpreter
        # loses its relative libpython path (python-build-standalone) and
        # aborts on first run. Windows keeps copies (no symlink privilege).
        venv.EnvBuilder(with_pip=True, symlinks=(os.name != "nt")).create(venv_dir)
        vpy = venv_python(project)
        created = True
    if not vpy:
        return {
            "status": "failed",
            "reason": "venv 생성 후 실행 파일을 찾지 못함: " + str(venv_dir),
        }, 1
    cmd = [
        str(vpy),
        "-m",
        "pip",
        "--disable-pip-version-check",
        "install",
        "--requirement",
        str(REQUIREMENTS),
    ]
    if no_index:
        cmd.append("--no-index")
    if find_links:
        cmd += ["--find-links", str(find_links)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    verified = {}
    versions = {}
    if proc.returncode == 0:
        for d in deps:
            if not _applicable(d):
                continue
            imported, version = _import_and_version(
                vpy, d["import_name"], d["dist"]
            )
            verified[d["dist"]] = imported and spec_satisfied(
                version, d["spec"], d["dist"]
            ) is True
            versions[d["dist"]] = version
    ok = proc.returncode == 0 and all(verified.values())
    return {
        "status": "installed" if ok else "failed",
        "venv": str(venv_dir),
        "venv_python": str(vpy),
        "created": created,
        "pip_argv": cmd,
        "pip_exit": proc.returncode,
        "pip_stdout_tail": proc.stdout[-2000:],
        "pip_stderr_tail": proc.stderr[-2000:],
        "installed_versions": versions,
        "verified_imports": verified,
        "requirements": str(REQUIREMENTS),
    }, (0 if ok else 1)


def _utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def main(argv=None):
    _utf8_stdio()
    if sys.version_info < (3, 10):
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": "Python 3.10 이상이 필요함 (현재 %d.%d). gg_deps.py python <폴더> 가 가리키는 인터프리터로 실행"
                    % sys.version_info[:2],
                },
                ensure_ascii=False,
            )
        )
        return 2
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["doctor", "ensure", "python"])
    ap.add_argument("folder", help="프로젝트 작업폴더")
    ap.add_argument(
        "--find-links",
        help="로컬 wheel 디렉터리(선택). site-packages 복사는 절대 아님.",
    )
    ap.add_argument(
        "--no-index",
        action="store_true",
        help="인덱스 조회 없이 --find-links만 사용(오프라인 설치)",
    )
    a = ap.parse_args(argv)
    try:
        if a.command == "doctor":
            print(json.dumps(doctor(a.folder), ensure_ascii=False, indent=2))
            return 0
        if a.command == "python":
            vpy = venv_python(a.folder)
            print(str(vpy) if vpy else sys.executable)
            return 0
        result, code = ensure(
            a.folder, find_links=a.find_links, no_index=a.no_index
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
