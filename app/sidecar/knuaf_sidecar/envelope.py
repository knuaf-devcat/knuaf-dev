"""Normalise the three output styles of the skill scripts into one envelope.

Scripts print (a) JSON on stdout, (b) a bare path on stdout, or (c) nothing
on stdout and `BLOCK: <msg>` on stderr. The envelope keeps the raw streams
so nothing is lost while giving the GUI stable fields.
"""
from __future__ import annotations

import json
import os


def normalize(argv, python, exit_code, stdout: str, stderr: str, duration_ms: int, cwd=None) -> dict:
    env = {
        "ok": False,
        "exit": exit_code,
        "status": None,
        "data": None,
        "path": None,
        "block_reason": None,
        "stdout": stdout,
        "stderr": stderr,
        "argv": list(map(str, argv)),
        "python": str(python),
        "duration_ms": duration_ms,
    }
    text = stdout.strip()
    data = _parse_json(text)
    if data is None and text:
        data = _parse_json(text.splitlines()[-1])
    if isinstance(data, (dict, list)):
        env["data"] = data
        if isinstance(data, dict):
            env["status"] = data.get("status")
            if isinstance(data.get("path"), str):
                env["path"] = data["path"]
    elif text and exit_code == 0 and len(text.splitlines()) == 1:
        candidate = text.splitlines()[0]
        full = candidate if os.path.isabs(candidate) or cwd is None else os.path.join(cwd, candidate)
        if os.path.exists(full):
            env["path"] = candidate
    err = stderr.strip()
    if err.startswith("BLOCK:"):
        env["block_reason"] = err.splitlines()[0][len("BLOCK:"):].strip()
        env["status"] = env["status"] or "blocked"
    elif isinstance(env["data"], dict) and env["data"].get("status") == "blocked":
        env["block_reason"] = env["data"].get("reason")
    env["ok"] = exit_code == 0 and env["status"] not in {"blocked", "fail", "failed"}
    return env


def _parse_json(text: str):
    if not text or text[0] not in "{[":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
