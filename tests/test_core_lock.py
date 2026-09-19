"""Lock lifecycle: audit C1 (Windows), C4 (stale lock recovery)."""
import json
import os
import socket

import pytest

import gg_core as core
from conftest import parse_json, run_gg


def test_lock_is_released_after_apply(project):
    assert not (project / ".gg-lock").exists()


def test_concurrent_lock_is_refused(project):
    with core.Lock(project):
        with pytest.raises(ValueError, match="쓰기 잠금"):
            with core.Lock(project):
                pass
    assert not (project / ".gg-lock").exists()


def test_init_on_windows_style_paths_and_korean_names(project):
    # the fixture folder already contains Korean + space; make sure nothing is left behind
    assert (project / "project.json").exists()
    assert not list(project.glob(".gg-tmp-*"))


def _plant_stale_lock(root, pid=999999, host=None):
    lock = root / ".gg-lock"
    lock.mkdir()
    (lock / "owner.json").write_text(
        json.dumps({"pid": pid, "host": host or socket.gethostname(), "token": "deadbeef"}),
        encoding="utf-8",
    )
    return lock


def test_stale_lock_blocks_apply(project):
    _plant_stale_lock(project)
    with pytest.raises(ValueError, match="쓰기 잠금"):
        core.apply(project, {"request_id": "r2", "ops": []}, 1)


def test_lock_info_reports_owner_and_verdict(project):
    _plant_stale_lock(project)
    r = run_gg(project, "lock-info")
    assert r.returncode == 0, r.stdout + r.stderr
    info = parse_json(r.stdout)
    assert info["present"] is True
    assert info["owner"]["pid"] == 999999
    assert info["host_matches"] is True
    assert info["pid_alive"] is False
    assert info["verdict"] == "stale_releasable"


def test_unlock_releases_stale_lock_and_apply_works_again(project):
    _plant_stale_lock(project)
    r = run_gg(project, "unlock")
    assert r.returncode == 0, r.stdout + r.stderr
    assert parse_json(r.stdout)["released"] is True
    assert not (project / ".gg-lock").exists()
    core.apply(project, {"request_id": "after-unlock", "ops": []}, 1)


def test_unlock_refuses_live_or_foreign_lock(project):
    _plant_stale_lock(project, pid=os.getpid())  # our own live pid
    r = run_gg(project, "unlock")
    assert r.returncode == 2 and parse_json(r.stdout)["status"] == "blocked"
    assert (project / ".gg-lock").exists()
    (project / ".gg-lock" / "owner.json").unlink()
    (project / ".gg-lock").rmdir()
    _plant_stale_lock(project, host="someone-elses-laptop")
    r = run_gg(project, "unlock")
    assert r.returncode == 2 and parse_json(r.stdout)["status"] == "blocked"
    assert (project / ".gg-lock").exists()


def test_doctor_shows_lock_owner(project):
    _plant_stale_lock(project)
    d = parse_json(run_gg(project, "doctor").stdout)
    assert d["lock"]["owner"]["pid"] == 999999
    assert d["lock"]["verdict"] == "stale_releasable"


# --- portable lock (audit C1): exercise the path-based branch on every OS ---


def test_lock_roundtrip_in_path_mode(project, monkeypatch):
    """The Windows branch of _DirRef (no dir_fd) must give the same lifecycle."""
    monkeypatch.setattr(core, "_FD_LOCKING", False)
    with core.Lock(project):
        assert (project / ".gg-lock" / "owner.json").exists()
        with pytest.raises(ValueError, match="쓰기 잠금"):
            with core.Lock(project):
                pass
    assert not (project / ".gg-lock").exists()
    core.apply(project, {"request_id": "path-mode", "ops": []}, 1)
    assert core.load(project)["revision"] == 2
    assert not (project / ".gg-lock").exists()


def test_lock_refuses_symlinked_lock_dir_in_path_mode(project, monkeypatch, tmp_path):
    monkeypatch.setattr(core, "_FD_LOCKING", False)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (project / ".gg-lock").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(ValueError, match="쓰기 잠금"):
        with core.Lock(project):
            pass
    assert (project / ".gg-lock").is_symlink()  # untouched


def test_export_falls_back_to_copy_when_hardlinks_fail(project, monkeypatch):
    import errno

    def no_link(*a, **k):
        raise OSError(errno.EPERM, "hard links not supported here")

    monkeypatch.setattr(core.os, "link", no_link)
    path = core.export(project, "draft")
    folder = project / "build" / "1" / "draft"
    assert (folder / "manifest.json").exists() and (folder / ".publication.json").exists()
    assert core.export_complete(folder, "draft", 1)
    assert path.endswith("검토전_초안.md")
    assert not list(project.glob("build/.gg-export-*"))


def test_export_in_path_mode(project, monkeypatch):
    monkeypatch.setattr(core, "_FD_LOCKING", False)
    core.export(project, "draft")
    assert core.export_complete(project / "build" / "1" / "draft", "draft", 1)
