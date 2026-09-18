"""Run a skill script as a subprocess with streaming logs, timeout and cancel."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from .envelope import normalize
from .rpc import RpcError

CREATE_NO_WINDOW = 0x08000000


def run_script(ctx, python, script_path, args, cwd, timeout: float, env_extra=None) -> dict:
    argv = [str(python), str(script_path), *map(str, args)]
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "KORDOC_OFFLINE": "1"})
    if env_extra:
        env.update(env_extra)
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    started = time.monotonic()
    ctx.progress("start", argv=argv, cwd=str(cwd))
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **kwargs,
    )
    ctx.process = proc
    out_buf, err_buf = [], []

    def pump(stream, buf, name):
        for line in iter(stream.readline, ""):
            buf.append(line)
            ctx.log(name, line.rstrip("\n"))
        stream.close()

    threads = [
        threading.Thread(target=pump, args=(proc.stdout, out_buf, "stdout"), daemon=True),
        threading.Thread(target=pump, args=(proc.stderr, err_buf, "stderr"), daemon=True),
    ]
    for t in threads:
        t.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill(proc)
    for t in threads:
        t.join(timeout=5)
    duration_ms = int((time.monotonic() - started) * 1000)
    if ctx.cancelled.is_set():
        raise RpcError("cancelled", "request cancelled", {"argv": argv})
    if timed_out:
        raise RpcError("timeout", "script exceeded %ss" % timeout, {"argv": argv, "stdout": "".join(out_buf)[-4000:], "stderr": "".join(err_buf)[-4000:]})
    envelope = normalize(argv, python, proc.returncode, "".join(out_buf), "".join(err_buf), duration_ms, cwd=str(cwd) if cwd else None)
    ctx.progress("done", ok=envelope["ok"], exit=envelope["exit"], duration_ms=duration_ms)
    return envelope


def _kill(proc):
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except (subprocess.TimeoutExpired, OSError):
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
            else:
                proc.kill()
        except OSError:
            pass


def project_python(project: Path):
    """Interpreter for dependency-needing scripts: the project venv, else None."""
    try:
        import gg_deps  # noqa: WPS433 - scripts dir is on sys.path
    except ImportError:
        return None
    return gg_deps.venv_python(project)
