"""gg.py import had no test on any platform, and its final directory rename
used os.replace(dir, existing_dir) — POSIX-only. Both branches run here."""
import sys

import pytest

import gg_core as core

from conftest import write_section

# The POSIX branch really is unavailable on Windows: os.replace onto an existing
# directory raises WinError 5 there, which is the whole reason for the split.
BRANCHES = [
    pytest.param(True, id="posix", marks=pytest.mark.skipif(
        sys.platform == "win32", reason="os.replace cannot target an existing directory on Windows")),
    pytest.param(False, id="windows"),
]


def legacy_folder(tmp_path):
    """A pre-project.json working folder, as a returning student would have."""
    src = tmp_path / "예전 작업"
    (src / "sections").mkdir(parents=True)
    (src / "sources").mkdir()
    (src / "sources" / "answers.md").write_text("면적 600평\n", encoding="utf-8")
    write_section(src, "sections/01.md", "Ⅰ. 머리말", "농장A의 재배 면적은 600평이다.")
    return src


@pytest.mark.parametrize("dir_rename_replaces", BRANCHES)
def test_import_lands_in_new_folder(tmp_path, monkeypatch, dir_rename_replaces):
    monkeypatch.setattr(core, "_DIR_RENAME_REPLACES", dir_rename_replaces)
    src = legacy_folder(tmp_path)
    out = tmp_path / "새 작업"

    p = core.migrate(src, out)

    assert (out / "project.json").is_file()
    assert p["revision"] >= 1
    # Originals are preserved byte-for-byte, and the source is left alone.
    assert (src / "sections" / "01.md").is_file()
    assert (out / "migration" / "original-sections").is_dir()
    assert not list(tmp_path.glob(".gg-import-*"))


@pytest.mark.parametrize("dir_rename_replaces", BRANCHES)
def test_import_refuses_existing_destination(tmp_path, monkeypatch, dir_rename_replaces):
    monkeypatch.setattr(core, "_DIR_RENAME_REPLACES", dir_rename_replaces)
    src = legacy_folder(tmp_path)
    out = tmp_path / "이미 있음"
    out.mkdir()
    (out / "keep.txt").write_text("사용자 파일", encoding="utf-8")

    with pytest.raises((ValueError, OSError)):
        core.migrate(src, out)

    # The user's existing folder must survive a refused import.
    assert (out / "keep.txt").read_text(encoding="utf-8") == "사용자 파일"


@pytest.mark.parametrize("dir_rename_replaces", BRANCHES)
def test_failed_rename_leaves_no_reserved_directory(tmp_path, monkeypatch, dir_rename_replaces):
    """The reservation must be released on failure, whichever branch ran."""
    monkeypatch.setattr(core, "_DIR_RENAME_REPLACES", dir_rename_replaces)
    src = legacy_folder(tmp_path)
    out = tmp_path / "실패"

    def boom(*a, **k):
        raise OSError("rename failed")

    monkeypatch.setattr(core.os, "replace", boom)
    monkeypatch.setattr(core.os, "rename", boom)
    with pytest.raises(OSError):
        core.migrate(src, out)
    assert not out.exists()
