"""One adapter for existing command entrypoints; no secondary state authority."""

import argparse
import json
from pathlib import Path
import sys
import gg_core as c
from gg_document import check


def main(mode):
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-doi", action="store_true")
    a = ap.parse_args()
    path = Path(a.target)
    try:
        root = path if path.is_dir() else path.parent.parent
        p = c.load(root) if (root / "project.json").exists() else None
        if mode == "status":
            if not p:
                raise ValueError(
                    "기존 작업: gg.py import 원본 --out 새폴더로 변환 대조 필요"
                )
            rows = c.checks(root, p)
            print(
                json.dumps(
                    {
                        "revision": p["revision"],
                        "checks": rows,
                        "tasks": c.next_tasks(p),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        if mode == "merge":
            if not p:
                raise ValueError("기존 작업을 먼저 gg.py import로 검증하여 가져오세요")
            print(c.export(root, "review"))
            return 0
        rows = []
        if mode == "evidence":
            if not p:
                raise ValueError(
                    "구형 원장 문자열을 검증 완료로 인정하지 않음. import 후 항목별 원문 대조 필요"
                )
            rows = c.checks(root, p)
        else:
            if p and path.is_dir():
                text = c.merged(root, p)
            elif path.is_file():
                text = c.draft(path.read_text(encoding="utf-8"))
                root = path.parent
            else:
                files = sorted(
                    (path / "sections").glob("*.md"),
                    key=lambda f: c.section_order(f.name),
                )
                text = "\n\n".join(c.draft(f.read_text(encoding="utf-8")) for f in files)
            rows = [
                c.result(cid, str(path), "fail", reason, p["revision"] if p else 0)
                for cid, reason in check(text, root)
            ]
            if not rows:
                rows = [
                    c.result(
                        "format",
                        str(path),
                        "pass",
                        "지원 텍스트 서식만 확인. 내용·렌더 별도",
                        p["revision"] if p else 0,
                    )
                ]
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return (
            1
            if any(r["status"] != "pass" and r["severity"] == "error" for r in rows)
            else 0
        )
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        ImportError,
        AttributeError,
        RecursionError,
    ) as e:
        print(
            json.dumps(
                [c.result("execution", str(path), "blocked", str(e), 0)],
                ensure_ascii=False,
            )
        )
        return 2
