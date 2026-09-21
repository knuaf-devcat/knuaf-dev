"""python -m knuaf_sidecar [--scripts-dir S]"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def default_scripts_dir() -> Path:
    env = os.environ.get("KNUAF_SCRIPTS_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for base in (here.parents[3] / "skills" / "knuaf-dev" / "scripts",  # repo layout
                 here.parents[2] / "skill" / "scripts"):                 # packaged app: resources/
        if (base / "gg_core.py").is_file():
            return base
    return here.parents[3] / "skills" / "knuaf-dev" / "scripts"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="knuaf_sidecar")
    ap.add_argument("--scripts-dir", default=None)
    ap.add_argument("--interpreter-kind", default="unknown", help="bundled|venv|custom (informational)")
    a = ap.parse_args(argv)
    if sys.version_info < (3, 10):
        sys.stdout.write('{"id": null, "error": {"code": "python_too_old", "message": "Python 3.10 이상 필요"}}\n')
        return 2
    scripts = Path(a.scripts_dir) if a.scripts_dir else default_scripts_dir()
    if not (scripts / "gg_core.py").is_file():
        sys.stdout.write('{"id": null, "error": {"code": "scripts_missing", "message": "%s"}}\n' % scripts)
        return 2
    sys.path.insert(0, str(scripts))
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    from . import methods_core, methods_scripts
    from .rpc import Server

    server = Server()
    methods_core.register(server)
    methods_scripts.register(server)
    server.register("sys.hello", lambda ctx, params: methods_core.sys_hello(ctx, {**params, "interpreter_kind": a.interpreter_kind}))
    server.write({"id": None, "event": "ready", "data": {"scripts_dir": str(scripts), "python": sys.executable}})
    server.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
