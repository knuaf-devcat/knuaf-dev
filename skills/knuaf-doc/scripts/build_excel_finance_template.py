#!/usr/bin/env python3
"""Generate only explicit, supported financial plans; never invented sample inputs."""

import argparse
import json
from pathlib import Path
from gg_core import local
from gg_finance import workbook

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("base")
    ap.add_argument(
        "--input", required=True, help="근거·기간·단위를 가진 계산 계약 JSON"
    )
    ap.add_argument("--out", default="build/검토전_재무.xlsx")
    a = ap.parse_args()
    try:
        result = workbook(
            json.loads(local(a.base, a.input).read_text(encoding="utf-8")), local(a.base, a.out)
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError) as e:
        print(json.dumps({"status": "blocked", "reason": str(e)}, ensure_ascii=False))
        raise SystemExit(2)
