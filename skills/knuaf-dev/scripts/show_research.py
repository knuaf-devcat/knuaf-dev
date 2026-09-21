#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""조사 내역 조회 — 사용자가 "이 수치 어디서 나왔나"를 물을 때 근거를 제시한다.

정본(`project.json`)의 facts/sources/tasks만 읽는다. 별도 원장을 두지 않으며
여기서 보이는 것은 전부 `gg.py apply`로 저장된 기록이다.

사용법:
    python3 show_research.py <작업폴더>                    전체 목록
    python3 show_research.py <작업폴더> --id S-003         특정 출처와 이를 쓰는 사실
    python3 show_research.py <작업폴더> --claim "5,500"    수치로 역추적
    python3 show_research.py <작업폴더> --section III-4    절이 쓰는 근거
"""
import argparse
import sys

import gg_core as core

KIND_NOTE = {
    "reported_fact": "사용자·원문이 보고한 사실",
    "observation": "직접 관측",
    "assumption": "가정 (검증 계획 필요)",
    "target": "목표값 (실적 아님)",
    "derived": "계산 결과",
}
VERIFY_NOTE = {
    "unreviewed": "미검토 (본문 사용 전 확인 필요)",
    "source_located": "원문 위치 확인됨",
    "claim_supported": "원문이 주장을 뒷받침함",
    "disputed": "이견 있음",
    "superseded": "대체됨",
}
OK = {"source_located", "claim_supported"}


def norm(text):
    return str(text or "").replace(",", "").replace(" ", "")


def fact_line(fid, f):
    mark = "OK" if f.get("verification") in OK else "!!"
    value = f.get("value")
    unit = f.get("unit") or ""
    shown = "%s %s" % (value, unit) if value is not None else "(%s)" % f.get("answer_state")
    return "  %s %-10s %-24s %s" % (mark, fid, f.get("field_id", ""), shown.strip())


def show_fact(p, fid, f):
    print("  [%s] %s" % (fid, f.get("field_id", "")))
    value = f.get("value")
    if value is None:
        print("      상태: %s — %s" % (f.get("answer_state"), f.get("reason") or "사유 없음"))
    else:
        print("      값: %s %s" % (value, f.get("unit") or ""))
    print("      범위/기간: %s / %s" % (f.get("scope") or "-", f.get("period") or "-"))
    kind = f.get("kind")
    print("      종류: %s (%s)" % (kind, KIND_NOTE.get(kind, "")))
    verification = f.get("verification")
    print("      검증: %s (%s)" % (verification, VERIFY_NOTE.get(verification, "")))
    if f.get("formula"):
        print("      계산식: %s" % f["formula"])
        print("      입력: %s" % ", ".join(r.get("id", "") for r in f.get("input_refs", [])))
    for ref in f.get("source_refs", []):
        src = p["sources"].get(ref.get("id"), {})
        print("      출처: %s — %s" % (ref.get("id"), src.get("path", "경로 없음")))
        print("            위치: %s" % ref.get("locator", "-"))
    if not f.get("source_refs"):
        print("      출처: 없음 — 본문 사용 전 근거 등록 필요")
    print()


def facts_citing(p, sid):
    return {
        fid: f
        for fid, f in p["facts"].items()
        if any(r.get("id") == sid for r in f.get("source_refs", []))
    }


def section_sources(p, section):
    """절이 쓰는 출처 — 작업 기록의 source_refs를 우선, 없으면 사실의 scope로 보완."""
    ids = set()
    for t in p["tasks"].values():
        linked = t.get("section") or t.get("section_id") or t.get("id", "")
        if section not in str(linked):
            continue
        for ref in t.get("source_refs", []):
            if ref.get("id"):
                ids.add(ref["id"])
    return ids


def main(argv=None):
    ap = argparse.ArgumentParser(description="정본 기준 근거 조회")
    ap.add_argument("folder")
    ap.add_argument("--id", dest="source_id", help="출처 ID")
    ap.add_argument("--claim", help="수치·문자열로 역추적")
    ap.add_argument("--section", help="절 ID")
    a = ap.parse_args(argv)

    try:
        p = core.load(a.folder)
    except (OSError, ValueError, KeyError) as e:
        print("정본을 읽을 수 없음: %s" % e)
        print("→ 기존 작업이면 `gg.py import <원본> --out <새폴더>`로 먼저 가져오세요.")
        return 2

    print("=" * 60)
    print("정본 개정 %s · 출처 %d · 사실 %d"
          % (p["revision"], len(p["sources"]), len(p["facts"])))
    print("=" * 60)

    if a.source_id:
        src = p["sources"].get(a.source_id)
        if not src:
            print("출처 %s 가 정본에 없다." % a.source_id)
            return 0
        print("[%s] %s" % (a.source_id, src.get("path", "")))
        print("  해시: %s" % (src.get("hash") or "-"))
        if src.get("extract_path"):
            print("  발췌: %s" % src["extract_path"])
        print()
        hits = facts_citing(p, a.source_id)
        print("이 출처를 쓰는 사실 %d건" % len(hits))
        for fid, f in sorted(hits.items()):
            show_fact(p, fid, f)
        return 0

    if a.claim:
        needle = norm(a.claim)
        print("'%s' 근거 추적" % a.claim)
        print()
        hits = {
            fid: f
            for fid, f in p["facts"].items()
            if needle and (needle in norm(f.get("value")) or needle in norm(f.get("field_id")))
        }
        if not hits:
            print("  정본에 해당 값이 없다.")
            print("  → 본문에 있다면 근거 없는 수치다. 확인이 필요하다.")
            return 0
        for fid, f in sorted(hits.items()):
            show_fact(p, fid, f)
        return 0

    if a.section:
        print("%s 절이 쓰는 근거" % a.section)
        print()
        ids = section_sources(p, a.section)
        if not ids:
            print("  작업 기록에 연결된 출처가 없다.")
            print("  → section-ledger.md: 각 절은 작업 기록을 하나 이상 연결해야 한다.")
            return 0
        total = 0
        for sid in sorted(ids):
            src = p["sources"].get(sid, {})
            print("[%s] %s" % (sid, src.get("path", "")))
            for fid, f in sorted(facts_citing(p, sid).items()):
                print(fact_line(fid, f))
                total += 1
            print()
        print("  출처 %d건 / 사실 %d건" % (len(ids), total))
        return 0

    by_kind = {}
    for fid, f in p["facts"].items():
        by_kind.setdefault(f.get("kind", "?"), []).append((fid, f))
    for kind in sorted(by_kind):
        rows = by_kind[kind]
        print("\n[%s] %d건 — %s" % (kind, len(rows), KIND_NOTE.get(kind, "")))
        for fid, f in sorted(rows):
            print(fact_line(fid, f))
    unverified = [fid for fid, f in p["facts"].items() if f.get("verification") not in OK]
    if unverified:
        print("\n미검증 %d건: %s" % (len(unverified), ", ".join(sorted(unverified))))
        print("기계검사는 내용검토를 대신하지 않는다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
