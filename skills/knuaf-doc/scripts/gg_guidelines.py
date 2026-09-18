#!/usr/bin/env python3
"""Fail-closed, source-bound checks for school writing requirements.

The inventory is immutable requirement metadata.  The current applicability,
locations, and verification state live in ``project.json`` rules, so a quote
in an inventory can never be mistaken for proof that the current document
complies.
"""
from __future__ import annotations

import json
from pathlib import Path

SCHEMA = "gg-guideline-inventory/v1"
KINDS = {"machine", "content", "visual", "user_finish"}
AUTHORITIES = {"instruction", "form", "example"}
REVIEW_KINDS = {"machine", "content", "visual", "render", "logic", "calculation", "docx", "xlsx"}


def _report(status, ready, profile_id=None, inventory=None, items=None,
            blockers=None, pending=None, reason=None):
    return {
        "schema": "gg-guideline-report/v1", "status": status,
        "guideline_ready": ready, "profile_id": profile_id,
        "inventory": inventory or {}, "items": items or [],
        "blockers": blockers or [], "pending_user_finish": pending or [],
        "reason": reason,
    }


def _school_source(p):
    for source in p.get("sources", {}).values():
        if not isinstance(source, dict):
            continue
        kind = str(source.get("kind", "")).lower()
        authority = str(source.get("authority", "")).lower()
        if kind in {"official_pdf", "school_rule", "school_rules", "official_rule"} or authority in {"school", "official_school"}:
            return True
    return False


def _source_ref(root, p, ref, digest, local):
    if not isinstance(ref, dict) or not isinstance(ref.get("id"), str):
        return False
    source = p.get("sources", {}).get(ref["id"])
    if not isinstance(source, dict) or ref.get("revision") != source.get("revision"):
        return False
    if not isinstance(ref.get("locator"), str) or not ref["locator"].strip():
        return False
    try:
        return digest(local(root, source["path"]).read_bytes()) == source.get("hash")
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _locations(root, p, locations):
    """Return section IDs, validating rule-owned locations."""
    if not isinstance(locations, list):
        return None
    ids = set()
    for loc in locations:
        if not isinstance(loc, dict) or not isinstance(loc.get("section_id"), str):
            return None
        if not isinstance(loc.get("quote"), str) or not loc["quote"].strip():
            return None
        sid = loc["section_id"]
        if sid in {"document", "project", "all"}:
            continue
        if sid not in p.get("sections", {}):
            return None
        try:
            from gg_core import draft, local
            body = draft(local(root, p["sections"][sid]["path"]).read_text(encoding="utf-8"))
            if loc["quote"] not in body:
                return None
        except (OSError, ValueError, KeyError, TypeError):
            return None
        ids.add(sid)
    return ids


def _review_output(root, p, review, coverage, section_ids, digest, local):
    """For visual evidence, bind the review to a real, current output file."""
    output_id = coverage.get("output_id") or review.get("output_id")
    if not output_id:
        return False
    output = p.get("outputs", {}).get(output_id)
    if not isinstance(output, dict) or not isinstance(output.get("path"), str):
        return False
    try:
        actual = digest(local(root, output["path"]).read_bytes())
    except (OSError, ValueError, TypeError):
        return False
    if output.get("file_hash") != actual:
        return False
    target_refs = output.get("target_refs")
    if not isinstance(target_refs, list) or not target_refs:
        return False
    output_sections = {x.get("id") for x in target_refs if isinstance(x, dict) and x.get("collection") == "sections"}
    if not section_ids.issubset(output_sections):
        return False
    try:
        from gg_core import fingerprint
        if output.get("input_fingerprint") != fingerprint(root, p, target_refs):
            return False
    except (OSError, ValueError, KeyError, TypeError):
        return False
    declared = coverage.get("output_file_hash") or review.get("output_file_hash")
    return declared == actual


def _valid_review(root, p, requirement_id, kind, section_ids):
    from gg_core import digest, fingerprint, local

    accepted = {"visual", "render"} if kind == "visual" else ({"content"} if kind == "content" else ({"docx", "xlsx", "calculation"} if kind == "machine" else REVIEW_KINDS))
    for review in p.get("reviews", {}).values():
        if not isinstance(review, dict) or review.get("review_kind") not in accepted:
            continue
        if review.get("status") != "pass" or review.get("disposition") != "resolved" or review.get("stale"):
            continue
        author, reviewer = review.get("author_id"), review.get("reviewer_id")
        if not isinstance(author, str) or not author.strip() or not isinstance(reviewer, str) or not reviewer.strip() or author == reviewer:
            continue
        findings = review.get("findings")
        if not isinstance(findings, list) or any(not isinstance(x, dict) for x in findings):
            continue
        if any(x.get("severity") == "error" and x.get("status") != "resolved" for x in findings):
            continue
        coverage = review.get("coverage")
        if not isinstance(coverage, dict) or not isinstance(coverage.get("guidelines"), list) or requirement_id not in coverage["guidelines"]:
            continue
        targets = review.get("target_refs")
        if not isinstance(targets, list) or not targets:
            continue
        covered = {x.get("id") for x in targets if isinstance(x, dict) and x.get("collection") == "sections"}
        if not section_ids.issubset(covered):
            continue
        if kind == "machine":
            checks = coverage.get("machine_checks")
            if not isinstance(checks, list):
                continue
            matched = False
            for machine in checks:
                if not isinstance(machine, dict) or machine.get("requirement_id") != requirement_id or machine.get("status") != "pass" or not isinstance(machine.get("check_id"), str) or not machine["check_id"].strip() or not isinstance(machine.get("evidence_path"), str) or not isinstance(machine.get("evidence_hash"), str) or not isinstance(machine.get("target_refs"), list) or not machine["target_refs"]:
                    continue
                try:
                    if machine.get("input_fingerprint") != fingerprint(root, p, machine["target_refs"]):
                        continue
                    if not section_ids.issubset({x.get("id") for x in machine["target_refs"] if isinstance(x, dict) and x.get("collection") == "sections"}):
                        continue
                    if digest(local(root, machine["evidence_path"]).read_bytes()) != machine["evidence_hash"]:
                        continue
                except (OSError, ValueError, KeyError, TypeError):
                    continue
                matched = True; break
            if not matched:
                continue
        if kind == "visual" and not _review_output(root, p, review, coverage, section_ids, digest, local):
            continue
        try:
            if review.get("input_fingerprint") != fingerprint(root, p, targets):
                continue
            path = local(root, review["path"])
            if review.get("report_hash") != digest(path.read_bytes()):
                continue
        except (OSError, ValueError, KeyError, TypeError):
            continue
        return {"review_kind": review.get("review_kind"), "id": review.get("id"), "path": review.get("path"), "input_fingerprint": review.get("input_fingerprint")}
    return None


def _valid_na(root, p, requirement, rule, section_ids, digest, local):
    if requirement.get("condition") is None:
        return False
    if not isinstance(rule.get("na_reason"), str) or not rule["na_reason"].strip():
        return False
    cond = rule.get("applies_when")
    if not isinstance(cond, dict) or cond.get("operator") != "equals" or not isinstance(cond.get("fact_id"), str) or "value" not in cond or not isinstance(cond.get("revision"), int):
        return False
    fact = p.get("facts", {}).get(cond["fact_id"])
    if not isinstance(fact, dict) or fact.get("revision") != cond["revision"] or fact.get("answer_state") != "provided" or fact.get("value") == cond["value"]:
        return False
    evidence = rule.get("na_evidence")
    if not isinstance(evidence, dict):
        return False
    ref = evidence.get("source_ref")
    if ref is not None:
        return _source_ref(root, p, ref, digest, local)
    path, sha = evidence.get("path"), evidence.get("sha256")
    if not isinstance(path, str) or not isinstance(sha, str):
        return False
    try:
        return digest(local(root, path).read_bytes()) == sha
    except (OSError, ValueError, TypeError):
        return False


def _conflicts_ok(root, p, inventory, profile, digest, local, blockers):
    conflicts = inventory.get("conflicts", [])
    if not isinstance(conflicts, list):
        blockers.append("conflicts")
        return
    resolutions = profile.get("conflict_resolutions", [])
    if not isinstance(resolutions, list):
        blockers.append("conflicts")
        return
    for conflict in conflicts:
        if not isinstance(conflict, dict):
            blockers.append("conflicts")
            continue
        if conflict.get("resolution_status") in {"resolved", "accepted"}:
            continue
        affected = conflict.get("ids")
        if not isinstance(affected, list) or not all(isinstance(x, str) for x in affected):
            blockers.append("conflicts")
            continue
        found = None
        for resolution in resolutions:
            if not isinstance(resolution, dict) or not isinstance(resolution.get("affected_ids"), list):
                continue
            if set(affected).issubset(set(x for x in resolution["affected_ids"] if isinstance(x, str))):
                found = resolution
                break
        if not found or not isinstance(found.get("basis"), str) or not found["basis"].strip() or not isinstance(found.get("reason"), str) or not found["reason"].strip() or not isinstance(found.get("source_refs"), list) or not found["source_refs"] or any(not _source_ref(root, p, ref, digest, local) for ref in found["source_refs"]):
            blockers.append("conflict:" + (affected[0] if affected else "unknown"))


def check(root, p):
    """Return a current, source-bound guideline coverage report."""
    profile = p.get("rules", {}).get("guideline_profile")
    if profile is None:
        if _school_source(p):
            return _report("blocked", False, reason="school source selected but guideline_profile is missing", blockers=["guideline_profile"])
        return _report("not_configured", None, reason="no school source/profile configured")
    if not isinstance(profile, dict) or profile.get("id") != "guideline_profile":
        return _report("blocked", False, reason="guideline_profile malformed", blockers=["guideline_profile"])
    profile_id = profile.get("profile_id")
    refs = profile.get("source_refs")
    binding = profile.get("inventory")
    expected = profile.get("requirement_ids")
    if not isinstance(profile_id, str) or not profile_id or not isinstance(refs, list) or not refs or not isinstance(binding, dict) or not isinstance(expected, list) or any(not isinstance(x, str) or not x for x in expected) or len(set(expected)) != len(expected):
        return _report("blocked", False, profile_id=profile_id, reason="guideline_profile fields malformed", blockers=["guideline_profile"])
    from gg_core import digest, local

    blockers = []
    for ref in refs:
        if not _source_ref(root, p, ref, digest, local):
            blockers.append("profile_source")
    inv_path, inv_hash = binding.get("path"), binding.get("sha256")
    inventory = None
    try:
        if not isinstance(inv_path, str) or not isinstance(inv_hash, str) or digest(local(root, inv_path).read_bytes()) != inv_hash:
            blockers.append("inventory_hash")
        else:
            inventory = json.loads(local(root, inv_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        blockers.append("inventory_read")
    inv_meta = {"path": inv_path, "sha256": inv_hash}
    if not isinstance(inventory, dict) or inventory.get("schema") != SCHEMA:
        return _report("blocked", False, profile_id=profile_id, inventory=inv_meta, blockers=sorted(set(blockers + ["inventory_schema"])), reason="guideline inventory missing or malformed")
    inv_source = inventory.get("source")
    if not isinstance(inv_source, dict) or not isinstance(inv_source.get("id"), str) or not isinstance(inv_source.get("sha256"), str) or type(inv_source.get("physical_page_count")) is not int or inv_source["physical_page_count"] < 1:
        blockers.append("inventory_source")
    else:
        source = p.get("sources", {}).get(inv_source["id"])
        if not isinstance(source, dict) or inv_source["sha256"] != source.get("hash") or not _source_ref(root, p, {"id": inv_source["id"], "revision": source.get("revision"), "locator": "inventory source"}, digest, local):
            blockers.append("inventory_source")
        if not any(isinstance(r, dict) and r.get("id") == inv_source["id"] for r in refs):
            blockers.append("inventory_source_binding")
        inv_meta["source_id"] = inv_source["id"]
    _conflicts_ok(root, p, inventory, profile, digest, local, blockers)
    requirements = inventory.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        return _report("blocked", False, profile_id=profile_id, inventory=inv_meta, blockers=sorted(set(blockers + ["requirements"])), reason="guideline requirements missing")
    by_id = {}
    for req in requirements:
        if not isinstance(req, dict) or not isinstance(req.get("id"), str) or req["id"] in by_id:
            blockers.append("requirement_shape")
            continue
        by_id[req["id"]] = req
    if set(by_id) != set(expected) or len(by_id) != len(requirements):
        blockers.append("requirement_ids")
    page_count = inventory.get("source", {}).get("physical_page_count")
    items, pending = [], []
    for rid in expected:
        req = by_id.get(rid)
        rule = p.get("rules", {}).get(rid)
        if req is None or not isinstance(rule, dict) or rule.get("id") != rid:
            items.append({"id": rid, "status": "blocked", "reason": "inventory or project rule missing"}); blockers.append(rid); continue
        shape_ok = (type(req.get("page")) is int and type(page_count) is int and 1 <= req["page"] <= page_count and isinstance(req.get("locator"), str) and bool(req["locator"].strip()) and isinstance(req.get("requirement"), str) and bool(req["requirement"].strip()) and isinstance(req.get("applies_to"), list) and all(isinstance(x, str) for x in req["applies_to"]) and isinstance(req.get("verification"), str) and bool(req["verification"].strip()) and isinstance(req.get("source_role"), str) and bool(req["source_role"].strip()) and isinstance(req.get("certainty"), str) and bool(req["certainty"].strip()) and req.get("kind") in KINDS and req.get("authority") in AUTHORITIES and (req.get("condition") is None or isinstance(req.get("condition"), str)))
        if not shape_ok:
            items.append({"id": rid, "kind": req.get("kind"), "status": "blocked", "reason": "inventory requirement fields invalid"}); blockers.append(rid); continue
        raw_locations = rule.get("locations", []) if req["kind"] == "user_finish" else rule.get("locations")
        section_ids = _locations(root, p, raw_locations)
        applicable = rule.get("applicable")
        rule_sources = rule.get("source_refs")
        if section_ids is None or (req["kind"] != "user_finish" and not rule.get("locations")) or type(applicable) is not bool or not isinstance(rule_sources, list) or not rule_sources or any(not _source_ref(root, p, ref, digest, local) for ref in rule_sources):
            items.append({"id": rid, "kind": req["kind"], "status": "blocked", "reason": "project rule locations/applicable invalid"}); blockers.append(rid); continue
        if applicable is False:
            na_ok = _valid_na(root, p, req, rule, section_ids, digest, local)
            if na_ok and req["kind"] != "user_finish" and _valid_review(root, p, rid, req["kind"], section_ids) is None:
                na_ok = False
            if na_ok:
                items.append({"id": rid, "kind": req["kind"], "status": "not_applicable", "reason": rule["na_reason"]})
            else:
                items.append({"id": rid, "kind": req["kind"], "status": "blocked", "reason": "N/A requires reason, false applies_when fact, and evidence"}); blockers.append(rid)
            continue
        if req["kind"] == "user_finish":
            pending.append(rid); items.append({"id": rid, "kind": req["kind"], "status": "pending", "owner": "user", "reason": "사용자 마무리 확인 필요"}); continue
        evidence = _valid_review(root, p, rid, req["kind"], section_ids)
        if evidence is None:
            items.append({"id": rid, "kind": req["kind"], "status": "blocked", "reason": "현재 파일/개정에 결합된 검증 근거 없음"}); blockers.append(rid)
        else:
            items.append({"id": rid, "kind": req["kind"], "status": "pass", "evidence": evidence})
    blockers = sorted(set(blockers))
    ready = not blockers
    return _report("blocked" if blockers else ("pass_with_notes" if pending else "pass"), ready, profile_id=profile_id, inventory=inv_meta, items=items, blockers=blockers, pending=pending)


if __name__ == "__main__":
    raise SystemExit("use gg.py check/status; this module is a library")
