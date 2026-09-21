#!/usr/bin/env python3
"""Bounded, offline Kordoc bootstrap and HWP-to-Markdown adapter.

The adapter deliberately keeps the npm package in an owned, versioned user
cache.  It never edits a system runtime, global npm configuration, or an input
document.  All process execution uses ``shell=False``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
import re


PACKAGE = "kordoc"
VERSION = "4.13.1"
REGISTRY = "https://registry.npmjs.org"
OWNER = "knuaf-dev.gg_kordoc"
LEGACY_OWNERS = frozenset({"ginseng-goat.gg_kordoc"})  # caches made before the rename
DEFAULT_TIMEOUT = 180
REQUIRED_PARSE_FLAGS = (
    "--format",
    "--keep-empty-cols",
    "--keep-empty-paragraphs",
    "--silent",
)


class KordocBlocked(RuntimeError):
    """A user-actionable, expected failure represented by status=blocked."""

    def __init__(self, reason: str, **details):
        super().__init__(reason)
        self.reason = reason
        self.details = details


def _result(status: str, **fields):
    return {"status": status, **fields}


def _owner_ok(value) -> bool:
    return value == OWNER or value in LEGACY_OWNERS


def _cache_root(value: str | os.PathLike[str] | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    base = os.environ.get("XDG_CACHE_HOME")
    if base:
        return (Path(base).expanduser() / "knuaf-dev" / "kordoc").resolve()
    return (Path.home() / ".cache" / "knuaf-dev" / "kordoc").resolve()


def _legacy_cache_roots() -> list[Path]:
    """Read-only: caches created under the old package name are reused, never written."""
    roots = []
    base = os.environ.get("XDG_CACHE_HOME")
    if base:
        roots.append((Path(base).expanduser() / "ginseng-goat" / "kordoc").resolve())
    roots.append((Path.home() / ".cache" / "ginseng-goat" / "kordoc").resolve())
    return [r for r in roots if r.is_dir()]


def _runtime_path(value: str | None, names: tuple[str, ...]) -> str | None:
    if value:
        candidate = Path(value).expanduser()
        if candidate.exists() and candidate.is_file():
            return str(candidate.resolve())
        found = shutil.which(value)
        return found
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _node_and_pnpm(node: str | None, pnpm: str | None, *, need_pnpm=True, check_node=True):
    node_path = _runtime_path(node, ("node",))
    pnpm_path = _runtime_path(pnpm, ("pnpm",)) if need_pnpm else None
    corepack = None
    if need_pnpm and not pnpm_path:
        corepack = _runtime_path(None, ("corepack",))
    missing = []
    if not node_path:
        missing.append("node")
    if need_pnpm and not pnpm_path and not corepack:
        missing.append("pnpm (or corepack)")
    if missing:
        raise KordocBlocked(
            "needs_runtime",
            missing=missing,
            action="Provide --node and --pnpm paths (the bundled host runtime may supply them), or install Node >=18 and pnpm.",
        )
    if check_node:
        version_probe = _run([node_path, "--version"], env=_env_for_node(node_path), timeout=15)
        version_text = (version_probe.get("stdout") or "").strip()
        match = re.match(r"v?(\d+)(?:\.(\d+))?", version_text)
        if not version_probe.get("ok") or not match or int(match.group(1)) < 18:
            raise KordocBlocked(
                "needs_runtime",
                missing=["node>=18"],
                node=node_path,
                probe=version_probe,
                action="Provide a Node >=18 executable with --node (the bundled host runtime may supply it).",
            )
    if not need_pnpm:
        return node_path, None
    if pnpm_path:
        pnpm_cmd = [pnpm_path]
    else:
        pnpm_cmd = [corepack, "pnpm"]
    return node_path, pnpm_cmd


# Variables an external process may inherit. Everything else — API keys,
# tokens, session credentials — is withheld from the third-party runtime.
_ENV_ALLOWLIST = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "http_proxy", "https_proxy", "no_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "PNPM_HOME", "COREPACK_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
    "NO_COLOR", "CI", "KORDOC_OFFLINE",
})


def _strip_proxy_userinfo(value: str) -> str:
    """Remove userinfo (user:pass@) embedded in a proxy value.

    Handles both scheme://user:pass@host[:port][/path] and the schemeless
    user:pass@host[:port] form.  An '@' outside the authority part (e.g. in
    the path) is left untouched.
    """
    if "@" not in value:
        return value
    if "://" in value:
        scheme, rest = value.split("://", 1)
        prefix = scheme + "://"
    else:
        prefix, rest = "", value
    authority, sep, tail = rest.partition("/")
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    return prefix + authority + (sep + tail if sep else "")


def _base_env() -> dict[str, str]:
    """Allowlisted slice of os.environ for external processes.

    Proxy variables keep their host/port but never embedded credentials:
    a child that echoes its environment must not be able to leak them.
    """
    env = {}
    for key, value in os.environ.items():
        if key not in _ENV_ALLOWLIST:
            continue
        if key.lower().endswith("_proxy"):
            value = _strip_proxy_userinfo(value)
        env[key] = value
    return env


def _env_for_node(node_path: str, *, offline: bool = False) -> dict[str, str]:
    env = _base_env()
    node_dir = str(Path(node_path).resolve().parent)
    env["PATH"] = node_dir + os.pathsep + os.environ.get("PATH", "")
    if offline:
        # Kordoc itself does not download OCR models unless OCR is requested;
        # this marker makes the offline contract explicit to wrappers/builds.
        env["KORDOC_OFFLINE"] = "1"
    return env


def _env_for_external(*, offline: bool = False, node_path: str | None = None) -> dict[str, str]:
    """Environment for a PATH or explicitly supplied Kordoc executable."""
    env = _base_env()
    if node_path:
        node_candidate = Path(node_path).expanduser()
        if node_candidate.is_file():
            env["PATH"] = str(node_candidate.resolve().parent) + os.pathsep + os.environ.get("PATH", "")
    if offline:
        env["KORDOC_OFFLINE"] = "1"
    return env


def _run(cmd: list[str], *, cwd: Path | None = None, env=None, timeout=DEFAULT_TIMEOUT):
    """Run one bounded process and return machine-readable process evidence."""
    try:
        cp = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        return {"ok": False, "kind": "missing_executable", "error": str(exc)}
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "kind": "timeout", "error": f"timed out after {timeout}s: {exc.cmd!r}"}
    except OSError as exc:
        return {"ok": False, "kind": "os_error", "error": str(exc)}
    return {
        "ok": cp.returncode == 0,
        "returncode": cp.returncode,
        # Keep enough of --help for capability checks; still bound process
        # evidence so a noisy third-party CLI cannot grow the result forever.
        "stdout": (cp.stdout or "")[-16000:],
        "stderr": (cp.stderr or "")[-16000:],
    }


def _read_json(path: Path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, TypeError):
        return None


def _package_paths(version_root: Path):
    package_root = version_root / "node_modules" / PACKAGE
    return package_root, package_root / "package.json", package_root / "dist" / "cli.js"


def _validated_install(version_root: Path, node_path: str):
    package_root, package_json, cli = _package_paths(version_root)
    marker = _read_json(version_root / ".gg-kordoc.json")
    spec = _read_json(package_json)
    if not marker or not _owner_ok(marker.get("owner")) or marker.get("version") != VERSION or marker.get("registry") != REGISTRY:
        return None
    if not spec or spec.get("name") != PACKAGE or str(spec.get("version")) != VERSION:
        return None
    if not cli.is_file():
        return None
    smoke = _run([node_path, str(cli), "--help"], env=_env_for_node(node_path), timeout=30)
    if not smoke.get("ok"):
        return None
    return {"version_root": version_root, "package_root": package_root, "cli": cli, "smoke": smoke}


def _version_from_probe(probe: dict) -> str | None:
    text = " ".join((probe.get("stdout") or "", probe.get("stderr") or ""))
    match = re.search(r"(?<![0-9])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?![0-9])", text)
    return match.group(1) if match else None


def _resolve_kordoc(value: str | None) -> tuple[str | None, str | None]:
    """Resolve an explicit path or the first PATH kordoc without touching cache."""
    if value:
        candidate = Path(value).expanduser()
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            raise KordocBlocked(
                "kordoc_missing",
                kordoc=str(candidate),
                explicit=True,
                action="The explicit --kordoc path is missing or not executable; provide a valid Kordoc CLI path.",
            )
        return str(candidate.resolve()), "explicit"
    found = shutil.which("kordoc")
    return (str(Path(found).resolve()), "path") if found else (None, None)


def _probe_external(path: str, *, source_kind: str, node_path: str | None = None, timeout=DEFAULT_TIMEOUT):
    """Verify identity, version and parse flags with bounded CLI smoke probes."""
    probe_env = _env_for_external(node_path=node_path)
    version_probe = _run([path, "--version"], env=probe_env, timeout=min(timeout, 30))
    help_probe = _run([path, "--help"], env=probe_env, timeout=min(timeout, 30))
    version = _version_from_probe(version_probe)
    help_text = " ".join((help_probe.get("stdout") or "", help_probe.get("stderr") or ""))
    missing_flags = [flag for flag in REQUIRED_PARSE_FLAGS if flag not in help_text]
    identity = "kordoc" in ((help_text + " " + (version_probe.get("stdout") or "") + " " + (version_probe.get("stderr") or "")).lower())
    rejection = []
    if not version_probe.get("ok"):
        rejection.append("version_probe_failed")
    if not help_probe.get("ok"):
        rejection.append("help_probe_failed")
    if not version:
        rejection.append("version_unparseable")
    if not identity:
        rejection.append("identity_missing")
    if missing_flags:
        rejection.append("required_flags_missing")
    evidence = {
        "path": path,
        "version_probe": version_probe,
        "help_probe": help_probe,
        "missing_flags": missing_flags,
        "identity": identity,
    }
    if rejection:
        evidence["reasons"] = rejection
        return None, evidence
    return {
        "cli_path": path,
        "cli_command": [path],
        "actual_version": version,
        "node_path": node_path,
        "source": "external",
        "source_kind": source_kind,
        "capability_verification": {
            "version": "ok",
            "help": "ok",
            "required_parse_flags": list(REQUIRED_PARSE_FLAGS),
            "smoke": "version_help",
        },
    }, evidence


def _claim_cache(root: Path):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker_path = root / ".gg-kordoc-cache.json"
    current = _read_json(marker_path)
    if current is not None:
        if not _owner_ok(current.get("owner")) or current.get("package") != PACKAGE or current.get("version") != VERSION or current.get("registry") != REGISTRY:
            raise KordocBlocked("cache_unowned", cache_dir=str(root), action="Choose a new --cache-dir; existing files are preserved.")
        return
    # Do not take over an arbitrary populated directory.
    if any(root.iterdir()):
        raise KordocBlocked("cache_unowned", cache_dir=str(root), action="Choose an empty --cache-dir; existing files are preserved.")
    payload = {
        "owner": OWNER,
        "package": PACKAGE,
        "version": VERSION,
        "registry": REGISTRY,
        "created_at": int(time.time()),
    }
    try:
        with marker_path.open("x", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    except FileExistsError:
        current = _read_json(marker_path)
        if not current or not _owner_ok(current.get("owner")) or current.get("package") != PACKAGE or current.get("version") != VERSION or current.get("registry") != REGISTRY:
            raise KordocBlocked("cache_unowned", cache_dir=str(root), action="Choose a new --cache-dir; existing files are preserved.")


def ensure(*, cache_dir=None, node=None, pnpm=None, kordoc=None, timeout=DEFAULT_TIMEOUT):
    """Ensure a validated Kordoc installation and return its CLI path."""
    rejected_candidates = []
    external_path, source_kind = _resolve_kordoc(kordoc)
    if external_path:
        # A supplied Node path is an environment hint for wrappers with a
        # node shebang; it does not make external reuse depend on Node checks.
        external_node = None
        if node:
            node_candidate = Path(node).expanduser()
            if node_candidate.is_file():
                external_node = str(node_candidate.resolve())
        candidate, evidence = _probe_external(
            external_path, source_kind=source_kind, node_path=external_node, timeout=timeout
        )
        if candidate:
            return _result(
                "ready",
                action="reused_existing",
                package=PACKAGE,
                version=candidate["actual_version"],
                actual_version=candidate["actual_version"],
                cli_path=candidate["cli_path"],
                cli_command=candidate["cli_command"],
                command=candidate["cli_command"],
                source=candidate["source"],
                source_kind=candidate["source_kind"],
                node_path=candidate.get("node_path"),
                capability_verification=candidate["capability_verification"],
                rejected_candidates=rejected_candidates,
            )
        evidence["source_kind"] = source_kind
        rejected_candidates.append(evidence)

    try:
        node_path, _ = _node_and_pnpm(node, pnpm, need_pnpm=False)
    except KordocBlocked as exc:
        if rejected_candidates:
            exc.details["rejected_candidates"] = rejected_candidates
        raise
    root = _cache_root(cache_dir)
    if cache_dir is None:
        for legacy_root in _legacy_cache_roots():
            legacy_cached = _validated_install(legacy_root / VERSION, node_path) if (legacy_root / VERSION).exists() else None
            if legacy_cached:
                return _result(
                    "ready",
                    action="reused_legacy",
                    package=PACKAGE,
                    version=VERSION,
                    actual_version=VERSION,
                    cache_dir=str(legacy_root),
                    cli_path=str(legacy_cached["cli"]),
                    cli_command=[node_path, str(legacy_cached["cli"])],
                    command=[node_path, str(legacy_cached["cli"])],
                    node_path=node_path,
                    smoke="help_ok",
                    capability_verification={"help": "ok", "smoke": "help"},
                    rejected_candidates=rejected_candidates,
                )
    _claim_cache(root)
    version_root = root / VERSION
    cached = _validated_install(version_root, node_path) if version_root.exists() else None
    if cached:
        return _result(
            "ready",
            action="reused",
            package=PACKAGE,
            version=VERSION,
            actual_version=VERSION,
            cache_dir=str(root),
            cli_path=str(cached["cli"]),
            cli_command=[node_path, str(cached["cli"])],
            command=[node_path, str(cached["cli"])],
            node_path=node_path,
            smoke="help_ok",
            capability_verification={"help": "ok", "smoke": "help"},
            rejected_candidates=rejected_candidates,
        )
    if version_root.exists():
        raise KordocBlocked(
            "cache_invalid",
            cache_dir=str(root),
            version=VERSION,
            rejected_candidates=rejected_candidates,
            action="Existing owned cache is incomplete or failed --help; choose a new cache or repair it manually. No files were overwritten.",
        )

    try:
        _, pnpm_cmd = _node_and_pnpm(node_path, pnpm, need_pnpm=True, check_node=False)
    except KordocBlocked as exc:
        if rejected_candidates:
            exc.details["rejected_candidates"] = rejected_candidates
        raise
    stage = root / f".staging-{VERSION}-{uuid.uuid4().hex}"
    stage.mkdir(mode=0o700)
    try:
        (stage / "package.json").write_text(
            json.dumps({"name": "knuaf-dev-kordoc-cache", "private": True}, indent=2) + "\n",
            encoding="utf-8",
        )
        install_cmd = pnpm_cmd + [
            "add",
            "--ignore-scripts",
            "--save-exact",
            "--store-dir",
            str(root / "store"),
            "--registry",
            REGISTRY,
            f"{PACKAGE}@{VERSION}",
        ]
        install_env = _env_for_node(node_path)
        install_env["COREPACK_HOME"] = str(root / "corepack")
        install_env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        install = _run(install_cmd, cwd=stage, env=install_env, timeout=timeout)
        if not install.get("ok"):
            raise KordocBlocked(
                "install_failed",
                command=install_cmd,
                process=install,
                action="Retry ensure; the partial staging directory is retained for audit and can be removed manually.",
            )
        # Claim the staging tree before validation so the same validator is
        # used for both fresh and reused installs.  It is published only after
        # the package metadata and --help smoke check pass.
        (stage / ".gg-kordoc.json").write_text(
            json.dumps({"owner": OWNER, "package": PACKAGE, "version": VERSION, "registry": REGISTRY}, indent=2) + "\n",
            encoding="utf-8",
        )
        validated = _validated_install(stage, node_path)
        if not validated:
            raise KordocBlocked("validation_failed", action="Install completed but package/version/CLI --help validation failed; no cache was published.")
        os.replace(stage, version_root)
        return _result(
            "ready",
            action="installed",
            package=PACKAGE,
            version=VERSION,
            actual_version=VERSION,
            cache_dir=str(root),
            cli_path=str(version_root / "node_modules" / PACKAGE / "dist" / "cli.js"),
            cli_command=[node_path, str(version_root / "node_modules" / PACKAGE / "dist" / "cli.js")],
            command=[node_path, str(version_root / "node_modules" / PACKAGE / "dist" / "cli.js")],
            node_path=node_path,
            smoke="help_ok",
            capability_verification={"help": "ok", "smoke": "help"},
            rejected_candidates=rejected_candidates,
        )
    except KordocBlocked:
        raise
    except OSError as exc:
        raise KordocBlocked("cache_publish_failed", error=str(exc), action="No cache was published; retry with a writable cache directory.")


def parse(input_path, out, *, cache_dir=None, node=None, pnpm=None, kordoc=None, timeout=DEFAULT_TIMEOUT):
    """Parse one document to a new markdown file, preserving sidecar images."""
    source = Path(input_path).expanduser().resolve()
    target = Path(out).expanduser().resolve()
    if not source.is_file():
        raise KordocBlocked("input_missing", input=str(source), action="Provide an existing HWP/HWPX/PDF/DOCX/XLSX file.")
    if source == target:
        raise KordocBlocked("input_output_same", input=str(source), output=str(target), action="Choose a new output path; input is never modified.")
    if target.exists():
        raise KordocBlocked("output_exists", output=str(target), action="Choose a new output path; existing files are never overwritten.")
    input_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    ready = ensure(cache_dir=cache_dir, node=node, pnpm=pnpm, kordoc=kordoc, timeout=timeout)
    cli = Path(ready["cli_path"])
    node_path = ready.get("node_path")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage_parent = Path(tempfile.mkdtemp(prefix=".gg-kordoc-", dir=str(target.parent)))
    stage_md = stage_parent / target.name
    cmd = list(ready.get("cli_command") or [node_path, str(cli)])
    cmd.extend([
        str(source),
        "-o",
        str(stage_md),
        "--format",
        "markdown",
        "--silent",
        "--keep-empty-cols",
        "--keep-empty-paragraphs",
    ])
    try:
        env = _env_for_node(node_path, offline=True) if node_path else _env_for_external(
            offline=True, node_path=ready.get("node_path")
        )
        process = _run(cmd, cwd=stage_parent, env=env, timeout=timeout)
        if not process.get("ok"):
            raise KordocBlocked("parse_failed", command=cmd, process=process, action="Input was preserved; no output was published.")
        # The primary output comes from an external process too: a symlink or
        # non-regular file (fifo/socket/dir) must never be followed, read, or
        # published as content.
        stage_root = stage_parent.resolve()
        if stage_md.is_symlink() or (stage_md.exists() and not stage_md.is_file()):
            raise KordocBlocked(
                "output_unsafe",
                output=str(stage_md),
                action="Kordoc output is not a regular file; the input was preserved and nothing was published.",
            )
        if stage_md.is_file() and not stage_md.resolve().is_relative_to(stage_root):
            raise KordocBlocked(
                "output_unsafe",
                output=str(stage_md),
                action="Kordoc output resolves outside staging; the input was preserved and nothing was published.",
            )
        if not stage_md.is_file() or stage_md.stat().st_size == 0:
            raise KordocBlocked("empty_output", action="Kordoc returned no markdown; no output was published.")
        if hashlib.sha256(source.read_bytes()).hexdigest() != input_hash:
            raise KordocBlocked("input_changed", action="Source changed while reading; retry the current source revision.")
        sidecars = stage_parent / "images"
        destination_sidecars = None
        if target.exists():
            raise KordocBlocked("output_exists", output=str(target), action="Output appeared during parse; existing files are preserved.")
        try:
            if sidecars.exists():
                # Sidecars come from an external process: publish only plain
                # files and directories that live inside the staging tree.
                # Links, fifos, sockets and anything resolving outside staging
                # are rejected recursively before anything is copied.  Nested
                # directories the adapter legitimately writes stay supported;
                # only the manifest (a flat basename list) governs link rewrite.
                if sidecars.is_symlink() or not sidecars.is_dir():
                    raise KordocBlocked(
                        "sidecar_unsafe",
                        sidecar=str(sidecars),
                        action="Kordoc produced an invalid sidecar path; the input was preserved and nothing was published.",
                    )
                sidecars_resolved = sidecars.resolve()
                for member in sorted(sidecars.rglob("*")):
                    if member.is_symlink() or (not member.is_file() and not member.is_dir()):
                        raise KordocBlocked(
                            "sidecar_unsafe",
                            sidecar=str(member.relative_to(sidecars)),
                            action="Kordoc sidecars must be regular files or directories inside staging; the input was preserved and nothing was published.",
                        )
                    if not member.resolve().is_relative_to(sidecars_resolved):
                        raise KordocBlocked(
                            "sidecar_unsafe",
                            sidecar=str(member.relative_to(sidecars)),
                            action="Kordoc sidecar escapes the staging directory; the input was preserved and nothing was published.",
                        )
                # Claim a unique per-document assets directory; no shared images
                # directory is replaced and another document can use this folder.
                destination_sidecars = Path(tempfile.mkdtemp(prefix="gg-assets-", dir=str(target.parent)))
                shutil.copytree(sidecars, destination_sidecars / "images")
                content = stage_md.read_text(encoding="utf-8")
                for prefix in ("(images/", "(./images/", 'src="images/', 'src="./images/'):
                    replacement = prefix.split("images/")[0].replace("./", "") + destination_sidecars.name + "/images/"
                    content = content.replace(prefix, replacement)
                # Actual Kordoc -o output may use bare names rather than images/.
                manifest = json.loads((sidecars / "manifest.json").read_text(encoding="utf-8"))
                if not isinstance(manifest, list):
                    raise OSError("Invalid image manifest")
                for item in manifest:
                    name = item.get("name") if isinstance(item, dict) else None
                    if not isinstance(name, str) or Path(name).name != name or not (sidecars / name).is_file():
                        raise OSError("Invalid image manifest entry")
                    for old in (name, "./" + name):
                        content = content.replace("](" + old + ")", "](" + destination_sidecars.name + "/images/" + name + ")")
                        content = content.replace('src="' + old + '"', 'src="' + destination_sidecars.name + '/images/' + name + '"')
                stage_md.write_text(content, encoding="utf-8")
            # Same-filesystem hard link publishes without overwriting a racing
            # destination. All supporting assets are complete before this point.
            os.link(stage_md, target)
        except (OSError, ValueError, TypeError) as exc:
            if destination_sidecars is not None:
                shutil.rmtree(destination_sidecars, ignore_errors=True)
            raise KordocBlocked("output_publish_failed", error=str(exc), action="No complete output was published; input and existing files are preserved.")
        output_bytes = target.read_bytes()
        return _result(
            "ready",
            action="parsed",
            input=str(source),
            output=str(target),
            bytes=len(output_bytes),
            input_sha256=input_hash,
            output_sha256=hashlib.sha256(output_bytes).hexdigest(),
            sidecars=str(destination_sidecars) if destination_sidecars is not None else None,
            offline=True,
            runtime=ready,
        )
    finally:
        shutil.rmtree(stage_parent, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bounded offline Kordoc bootstrap/parser")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("ensure", "parse"):
        p = sub.add_parser(name)
        p.add_argument("--cache-dir")
        p.add_argument("--node", help="node executable path (bundled host runtime accepted)")
        p.add_argument("--pnpm", help="pnpm executable path (bundled host runtime accepted)")
        p.add_argument("--kordoc", help="existing Kordoc CLI executable path (reused when compatible)")
        p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
        if name == "parse":
            p.add_argument("input")
            p.add_argument("--out", required=True)
    try:
        args = parser.parse_args(argv)
        if args.command == "ensure":
            value = ensure(cache_dir=args.cache_dir, node=args.node, pnpm=args.pnpm, kordoc=args.kordoc, timeout=args.timeout)
        else:
            value = parse(args.input, args.out, cache_dir=args.cache_dir, node=args.node, pnpm=args.pnpm, kordoc=args.kordoc, timeout=args.timeout)
    except KordocBlocked as exc:
        value = _result("blocked", reason=exc.reason, **exc.details)
        print(json.dumps(value, ensure_ascii=False, indent=2))
        return 2
    except (OSError, ValueError, TypeError) as exc:
        print(json.dumps(_result("blocked", reason="unexpected_error", error=str(exc)), ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
