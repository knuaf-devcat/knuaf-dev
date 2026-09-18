#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""조사 내역 조회 — 사용자가 "이 수치 어디서 나왔나"를 물을 때 근거를 제시한다.

사용법:
    python3 show_research.py <작업폴더>                    전체 목록
    python3 show_research.py <작업폴더> --id Q-007         특정 조사 상세
    python3 show_research.py <작업폴더> --claim "5,500주"  수치로 역추적
    python3 show_research.py <작업폴더> --section III-4    절별 근거
"""
import sys, os, re, json

def load_receipts(base):
    p = os.path.join(base, "02_receipts.jsonl")
    out = []
    if not os.path.exists(p):
        return out
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out

def load_log(base):
    p = os.path.join(base, "04_research_log.md")
    if not os.path.exists(p):
        return {}
    text = open(p, encoding="utf-8").read()
    blocks = {}
    for m in re.finditer(r"^##\s+\[(Q-\d+)\]\s*(.*?)$(.*?)(?=^##\s+\[|\Z)", text, re.M | re.S):
        blocks[m.group(1)] = (m.group(2).strip(), m.group(3).strip())
    return blocks

GRADE_NOTE = {
    "doi-confirmed": "1등급 학술논문(DOI 확인)",
    "law-cited": "1등급 법령(조항 명시)",
    "agency-named": "1~2등급 기관 자료",
    "soffice-recalc-match": "직접 재계산 검증",
    "user-stated": "사용자 제공",
    "unverified": "미검증 (본문 사용 불가)",
}

def show_receipt(r):
    print("  [{}] {}".format(r.get("id"), r.get("claim", "")))
    print("      출처: {}".format(r.get("source", "")))
    if r.get("locator"):
        print("      위치: {}".format(r["locator"]))
    v = r.get("verified", "unverified")
    print("      경로: {} / 검증: {} ({})".format(
        r.get("method", "?"), v, GRADE_NOTE.get(v, "")))
    if r.get("sections"):
        print("      사용 절: {}".format(", ".join(r["sections"])))
    print()

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = sys.argv[1]
    args = sys.argv[2:]
    receipts = load_receipts(base)
    log = load_log(base)

    def opt(name):
        return args[args.index(name) + 1] if name in args else None

    qid, claim, section = opt("--id"), opt("--claim"), opt("--section")

    if qid:
        if qid in log:
            title, body = log[qid]
            print("=" * 60)
            print("[{}] {}".format(qid, title))
            print("=" * 60)
            print(body)
        else:
            print("조사 로그에 {}가 없다.".format(qid))
        return 0

    if claim:
        print("=" * 60)
        print("'{}' 근거 추적".format(claim))
        print("=" * 60)
        hit = [r for r in receipts if claim.replace(",", "") in r.get("claim", "").replace(",", "")]
        if hit:
            for r in hit:
                show_receipt(r)
        else:
            print("  증거 원장에 해당 수치가 없다.")
            print("  → 본문에 있다면 근거 없는 수치다. 확인이 필요하다.")
        return 0

    if section:
        print("=" * 60)
        print("{} 절이 사용하는 근거".format(section))
        print("=" * 60)
        hit = [r for r in receipts if section in r.get("sections", [])]
        for r in hit:
            show_receipt(r)
        print("  총 {}건".format(len(hit)))
        return 0

    print("=" * 60)
    print("증거 원장 전체 ({}건)".format(len(receipts)))
    print("=" * 60)
    kinds = {}
    for r in receipts:
        kinds.setdefault(r.get("kind", "?"), []).append(r)
    for k in sorted(kinds):
        print("\n[{}] {}건".format(k, len(kinds[k])))
        for r in kinds[k]:
            v = r.get("verified", "unverified")
            mark = "OK" if v != "unverified" else "!!"
            print("  {} {:<8} {}".format(mark, r.get("id", ""), r.get("claim", "")[:52]))
    if log:
        print("\n조사 로그 {}건: {}".format(len(log), ", ".join(sorted(log))))
    return 0

if __name__ == "__main__":
    sys.exit(main())

