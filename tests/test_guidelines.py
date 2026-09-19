"""gg_guidelines: fail-closed coverage of the school's writing requirements.

README calls guideline decomposition the core of this tool, and it had no test.
Every path here is about one property: **you cannot reach `guideline_ready`
by supplying a document the project cannot still verify.** A quote sitting in
an inventory is metadata, not proof about the current manuscript.
"""
import json

import pytest

import gg_core as core
import gg_guidelines as gl


def load(project):
    return core.load(project)


def add_school_source(project, kind="official_pdf"):
    """Register a school-rule source so _school_source() sees one."""
    path = project / "sources" / "school.pdf"
    path.write_bytes(b"%PDF-1.4 school rules\n")
    p = load(project)
    p["sources"]["src-school"] = {
        "id": "src-school", "revision": p["revision"], "path": "sources/school.pdf",
        "kind": kind, "hash": core.digest(path.read_bytes()), "claims": {},
    }
    return p, path


def write_inventory(project, requirements, *, schema=gl.SCHEMA, pages=26, source_id="src-school", source_hash=None):
    inv = {
        "schema": schema,
        "source": {"id": source_id, "sha256": source_hash, "physical_page_count": pages},
        "requirements": requirements,
        "conflicts": [],
    }
    path = project / "sources" / "guidelines" / "inventory.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(inv, ensure_ascii=False), encoding="utf-8")
    return path


# --- nothing configured -------------------------------------------------------

def test_an_empty_project_is_not_configured_rather_than_passing(project):
    r = gl.check(project, load(project))
    assert r["status"] == "not_configured"
    assert r["guideline_ready"] is None, "설정 전 상태를 준비됨으로 읽으면 안 됨"
    assert r["blockers"] == []


def test_a_school_source_without_a_profile_blocks(project):
    """The rules are in the project but nothing decomposed them yet."""
    p, _ = add_school_source(project)
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert r["guideline_ready"] is False
    assert "guideline_profile" in r["blockers"]


@pytest.mark.parametrize("profile", [
    "not-a-dict",
    {"id": "wrong_id"},
    {"id": "guideline_profile"},                                   # no fields
    {"id": "guideline_profile", "profile_id": "", "source_refs": [], "inventory": {}, "requirement_ids": []},
    {"id": "guideline_profile", "profile_id": "x", "source_refs": [{"id": "s"}], "inventory": {}, "requirement_ids": ["A", "A"]},  # dup ids
])
def test_a_malformed_profile_blocks_instead_of_being_skipped(project, profile):
    p = load(project)
    p["rules"]["guideline_profile"] = profile
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert r["guideline_ready"] is False


# --- the inventory must still be the one that was reviewed --------------------

def _profile(p, inv_path, inv_hash, requirement_ids):
    return {
        "id": "guideline_profile", "profile_id": "knuaf-2020",
        "source_refs": [{"id": "src-school", "revision": p["revision"], "locator": "p.1-5"}],
        "inventory": {"path": str(inv_path), "sha256": inv_hash},
        "requirement_ids": requirement_ids,
    }


def test_a_tampered_inventory_blocks_on_the_hash(project):
    """Editing the inventory after review must not silently take effect."""
    p, src = add_school_source(project)
    inv = write_inventory(project, [], source_hash=core.digest(src.read_bytes()))
    rel = "sources/guidelines/inventory.json"
    p["rules"]["guideline_profile"] = _profile(p, rel, core.digest(inv.read_bytes()), [])

    # Before: the hash binds, so the only complaint is the empty requirement list.
    before = gl.check(project, p)["blockers"]
    assert "inventory_hash" not in before, before

    inv.write_text(inv.read_text(encoding="utf-8").replace('"conflicts": []', '"conflicts": [1]'), encoding="utf-8")

    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert "inventory_hash" in r["blockers"], "변조가 해시 결합을 깨지 못했다"
    assert r["guideline_ready"] is False


def test_a_foreign_schema_blocks(project):
    p, src = add_school_source(project)
    inv = write_inventory(project, [], schema="something-else/v9", source_hash=core.digest(src.read_bytes()))
    p["rules"]["guideline_profile"] = _profile(p, "sources/guidelines/inventory.json", core.digest(inv.read_bytes()), [])
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    # The file itself is intact, so the schema is the complaint, not the hash.
    assert "inventory_schema" in r["blockers"]
    assert "inventory_hash" not in r["blockers"], r["blockers"]


def test_an_unreadable_inventory_blocks_rather_than_raising(project):
    p, src = add_school_source(project)
    path = project / "sources" / "guidelines" / "inventory.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    p["rules"]["guideline_profile"] = _profile(p, "sources/guidelines/inventory.json", core.digest(path.read_bytes()), [])
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert r["guideline_ready"] is False


def test_an_inventory_outside_the_working_folder_is_refused(project):
    p, _ = add_school_source(project)
    p["rules"]["guideline_profile"] = _profile(p, "../탈출.json", "0" * 64, [])
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert r["guideline_ready"] is False


def test_requirements_missing_from_the_inventory_block(project):
    """The profile promises requirement ids; the inventory must actually hold them."""
    p, src = add_school_source(project)
    inv = write_inventory(project, [], source_hash=core.digest(src.read_bytes()))
    p["rules"]["guideline_profile"] = _profile(
        p, "sources/guidelines/inventory.json", core.digest(inv.read_bytes()), ["OG-001"])
    r = gl.check(project, p)
    assert r["status"] == "blocked"
    assert r["guideline_ready"] is False


# --- the report shape the app and gg.py rely on -------------------------------

def test_every_report_carries_the_schema_and_readiness_fields(project):
    r = gl.check(project, load(project))
    assert r["schema"] == "gg-guideline-report/v1"
    assert set(r) >= {"status", "guideline_ready", "profile_id", "inventory",
                      "items", "blockers", "pending_user_finish", "reason"}


def test_ready_is_never_true_while_any_blocker_stands(project):
    p, _ = add_school_source(project)
    r = gl.check(project, p)
    assert r["blockers"] and r["guideline_ready"] is not True
