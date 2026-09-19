"""JSON-lines request/response/event framing and dispatch."""
from __future__ import annotations

import json
import sys
import threading
import traceback


class RpcError(Exception):
    def __init__(self, code: str, message: str, data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class Context:
    """Per-request handle: emit events, observe cancellation, own a subprocess."""

    def __init__(self, server: "Server", request_id):
        self.server = server
        self.id = request_id
        self.cancelled = threading.Event()
        self.process = None

    def emit(self, event: str, data=None):
        self.server.write({"id": self.id, "event": event, "data": data})

    def progress(self, phase: str, **data):
        self.emit("progress", {"phase": phase, **data})

    def log(self, stream: str, line: str):
        self.emit("log", {"stream": stream, "line": line})

    def cancel(self):
        self.cancelled.set()
        proc = self.process
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass


class Server:
    def __init__(self, inp=None, out=None):
        self.inp = inp or sys.stdin
        self.out = out or sys.stdout
        self.methods = {}
        self.pending: dict = {}
        self._out_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self.write_lock = threading.Lock()  # serialises gg_core write transactions
        self.register("methods.list", self._methods_list)

    def _methods_list(self, ctx, params):
        """Introspection for the Electron host: which calls mutate the project (GUI gates those)."""
        return [{"name": name, "write": write} for name, (fn, write) in sorted(self.methods.items())]

    def register(self, name: str, fn, write: bool = False):
        self.methods[name] = (fn, write)

    def write(self, message: dict):
        line = json.dumps(message, ensure_ascii=False, default=str)
        with self._out_lock:
            self.out.write(line + "\n")
            self.out.flush()

    def serve(self):
        threads = []
        for raw in self.inp:
            raw = raw.strip()
            if not raw:
                continue
            try:
                request = json.loads(raw)
            except json.JSONDecodeError as error:
                self.write({"id": None, "error": {"code": "invalid_request", "message": str(error)}})
                continue
            if not isinstance(request, dict):
                self.write({"id": None, "error": {"code": "invalid_request", "message": "object expected"}})
                continue
            if request.get("method") == "cancel":
                target = (request.get("params") or {}).get("id")
                with self._pending_lock:
                    ctx = self.pending.get(target)
                if ctx is not None:
                    ctx.cancel()
                self.write({"id": request.get("id"), "result": {"cancelled": ctx is not None}})
                continue
            if request.get("method") == "shutdown":
                self.write({"id": request.get("id"), "result": {"bye": True}})
                break
            t = threading.Thread(target=self._handle, args=(request,), daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join(timeout=5)

    def _handle(self, request: dict):
        rid = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        ctx = Context(self, rid)
        with self._pending_lock:
            self.pending[rid] = ctx
        try:
            entry = self.methods.get(method)
            if entry is None:
                raise RpcError("not_found", "unknown method: %s" % method)
            fn, write = entry
            if not isinstance(params, dict):
                raise RpcError("invalid_params", "params must be an object")
            if write:
                with self.write_lock:
                    result = fn(ctx, params)
            else:
                result = fn(ctx, params)
            if ctx.cancelled.is_set():
                raise RpcError("cancelled", "request cancelled")
            self.write({"id": rid, "result": result})
        except RpcError as error:
            self.write({"id": rid, "error": {"code": error.code, "message": error.message, "data": error.data}})
        except Exception as error:  # noqa: BLE001 - the protocol must always answer
            self.write(
                {
                    "id": rid,
                    "error": {
                        "code": classify_exception(error),
                        "message": str(error),
                        "data": {"type": type(error).__name__, "traceback": traceback.format_exc()[-4000:]},
                    },
                }
            )
        finally:
            with self._pending_lock:
                self.pending.pop(rid, None)


def classify_exception(error: Exception) -> str:
    text = str(error)
    if isinstance(error, ValueError):
        if text.startswith("쓰기 잠금"):
            return "lock_held"
        if text.startswith("개정 충돌") or "낡은 개정" in text:
            return "revision_stale"
        if "덮어쓰지 않음" in text or "덮어쓰기" in text:
            return "overwrite_refused"
        if text.startswith("잠금 해제 거부"):
            return "lock_ambiguous"
        return "business_rule"
    if isinstance(error, ImportError):
        return "deps_not_ready"
    if isinstance(error, FileNotFoundError):
        return "not_found"
    if isinstance(error, PermissionError):
        return "permission"
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, (KeyError, TypeError)):
        return "invalid_params"
    return "internal"
