#!/usr/bin/env python3
"""Local command interface; never calls model providers or web services."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import gg_core as core


def main(argv=None):
    ap = argparse.ArgumentParser(description="논문 정본·검사·검토본 관리")
    ap.add_argument(
        "command",
        choices=[
            "init",
            "doctor",
            "import",
            "status",
            "next",
            "apply",
            "check",
            "export",
            "question",
            "bundle",
            "paper",
            "observe",
        ],
    )
    ap.add_argument("folder")
    ap.add_argument("--out")
    ap.add_argument("--change")
    ap.add_argument("--expected-revision", type=int)
    ap.add_argument("--scope", default="all")
    ap.add_argument(
        "--kind", choices=["draft", "review", "submission_candidate"], default="review"
    )
    ap.add_argument("--field")
    ap.add_argument("--input")
    ap.add_argument("--observer")
    a = ap.parse_args(argv)
    try:
        if a.command == "init":
            value = core.init(a.folder)
        elif a.command == "import":
            if not a.out:
                raise ValueError("--out 새 폴더 필요")
            value = core.migrate(a.folder, a.out)
        elif a.command == "doctor":
            value = {
                "python": sys.version,
                "dependencies": {
                    m: bool(importlib.util.find_spec(m)) for m in ("docx", "openpyxl")
                },
                "recalculation": "not_run",
                "render": "not_run",
                "hwp": "unsupported",
                "web": "not_run",
                "model_calls": "disabled",
                "lock_present": (Path(a.folder) / ".gg-lock").exists(),
                "orphan_files": [
                    str(p)
                    for p in list(Path(a.folder).rglob(".gg-tmp-*"))
                    + list(Path(a.folder).rglob(".gg-export-*"))
                ],
                "notice": "설치 탐지는 실행 검증이 아님. 채팅만 가능하면 초안과 원답변 인계, 제출 후보 불가.",
            }
        elif a.command == "observe":
            if not a.input or not a.observer:
                raise ValueError("--input 관측 JSON과 --observer 필요")
            payload = json.loads(core.local(a.folder, a.input).read_text())
            if not isinstance(payload, dict):
                raise ValueError("관측 기록은 객체여야 함")
            value = core.ingest_review_observation(a.folder, payload, a.observer)
        elif a.command == "paper":
            if not a.input:
                raise ValueError("--input 논문 입력 JSON 필요")
            from gg_school_paper import paper as school_paper

            src = core.local(a.folder, a.input)
            dest = core.local(a.folder, a.out or "build/검토전_본문.md")
            if dest.exists():
                raise ValueError("기존 산출물을 덮어쓰지 않음")
            dest.parent.mkdir(parents=True, exist_ok=True)
            spec = json.loads(src.read_text())
            if not isinstance(spec, dict):
                raise ValueError("논문 입력은 객체여야 함")
            spec.setdefault("school_profile", {"mode": "school", "layout": "forms_1_to_4"})
            dest.write_text(school_paper(spec))
            value = {"path": str(dest), "status": "generated"}
        else:
            p = core.load(a.folder)
            if a.command == "apply":
                if not a.change or a.expected_revision is None:
                    raise ValueError("--change와 --expected-revision 필요")
                value = core.apply(
                    a.folder,
                    json.loads(Path(a.change).read_text()),
                    a.expected_revision,
                )
            elif a.command == "check":
                value = (
                    core.gate(a.folder, p)
                    if a.scope == "submission"
                    else core.checks(a.folder, p)
                )
            elif a.command == "status":
                report = core.gate(a.folder, p)
                state = core.completion(a.folder, p, report)
                value = {
                    "revision": p["revision"],
                    "checks": core.checks(a.folder, p),
                    "tasks": core.next_tasks(p),
                    "completion": state,
                    "skill_ready": state["skill_ready"],
                    "guideline_ready": state["guideline_ready"],
                    "user_finish_pending": state["user_finish_pending"],
                    "professor_approval_pending": state["professor_approval_pending"],
                    "professor_approval": "별도 기록 확인 필요",
                }
            elif a.command == "next":
                value = core.next_tasks(p)
            elif a.command == "question":
                if not a.field:
                    raise ValueError("--field 필요")
                action = core.question(p, a.field)
                if action in {"ask", "help"}:
                    q = p["questions"].get(
                        a.field,
                        {
                            "id": a.field,
                            "field_id": a.field,
                            "decision_revision": 1,
                            "attempts": 0,
                        },
                    )
                    q = dict(q, attempts=q["attempts"] + 1)
                    core.apply(
                        a.folder,
                        {
                            "request_id": "question:%s:%s:%s"
                            % (a.field, q["decision_revision"], q["attempts"]),
                            "ops": [{"collection": "questions", "value": q}],
                        },
                        p["revision"],
                    )
                value = {
                    "action": action,
                    "field": a.field,
                    "notice": "질문 1회·도움 1회 후 해당 작업만 보류",
                }
            elif a.command == "bundle":
                if a.scope not in p["sections"]:
                    raise ValueError("--scope 절 ID 필요")
                s = p["sections"][a.scope]
                refs = [{"collection": "sections", "id": a.scope}]
                value = {
                    "section": s,
                    "draft": core.draft(core.local(a.folder, s["path"]).read_text()),
                    "original_sources": p["sources"],
                    "facts": p["facts"],
                    "rules": p["rules"],
                    "input_fingerprint": core.fingerprint(a.folder, p, refs),
                    "review_axes": [
                        "사실성",
                        "적용 타당성",
                        "논증",
                        "실행성",
                        "일관성",
                        "균형성",
                        "표현",
                    ],
                    "required_findings": [
                        "본문 위치",
                        "원문 위치",
                        "문제",
                        "영향",
                        "수정 조건",
                    ],
                    "notice": "요약 대신 실제 원답변·원문 파일을 읽어 대조. 같은 작성자의 자가검토는 독립검토가 아님.",
                }
            else:
                value = {"path": core.export(a.folder, a.kind)}
        print(json.dumps(value, ensure_ascii=False, indent=2))
        if a.command == "check" and any(
            core.blocks_skill_candidate(r)
            if a.scope == "submission"
            else r["severity"] == "error" and r["status"] != "pass"
            for r in value
        ):
            return 1
        return 0
    except (ValueError, KeyError, OSError, TypeError) as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
