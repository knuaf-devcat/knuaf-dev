"""Optional end-to-end check against a real template workbook.

Set KNUAF_REAL_TEMPLATE=/path/to/양식.xlsx to enable; skipped otherwise."""
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

import pytest

from conftest import parse_json, run_script
from test_excel_template import assert_structure_preserved, formula_map as _formulas

openpyxl = pytest.importorskip("openpyxl")

REAL = os.environ.get("KNUAF_REAL_TEMPLATE")
pytestmark = pytest.mark.skipif(
    not REAL or not Path(REAL).is_file(),
    reason="KNUAF_REAL_TEMPLATE unset or file missing",
)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.fixture
def real_project(tmp_path):
    original = Path(REAL)
    before = sha256(original)
    root = tmp_path / "실전 과제"
    (root / "sources").mkdir(parents=True)
    src = root / "sources" / "양식.xlsx"
    shutil.copyfile(original, src)
    src.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)   # read-only copy
    yield {"original": original, "before": before, "root": root, "src": src}
    assert sha256(original) == before, "original template must never be modified"


def test_real_template_inspect_and_clear(real_project):
    src, root = real_project["src"], real_project["root"]
    out_map = root / "map.json"
    r = run_script("gg_excel_template.py", "inspect", "--source", src, "--out-map", out_map)
    assert r.returncode == 0, r.stderr
    summary = parse_json(r.stdout)
    assert summary["entries_source"] == "inventory"
    assert summary["sheets"] >= 1
    data = json.loads(out_map.read_text(encoding="utf-8"))
    sheet_names = [s["name"] for s in data["sheets"]]
    assert len(sheet_names) == summary["sheets"]
    assert all(e["sheet"] in sheet_names for e in data["entries"])

    out = root / "blank.xlsx"
    receipt = root / "receipt.json"
    r = run_script("gg_excel_template.py", "clear", "--source", src, "--map", out_map,
                   "--out", out, "--receipt", receipt)
    assert r.returncode == 0, r.stderr
    cleared = parse_json(r.stdout)
    assert cleared["missing"] == 0
    rec = json.loads(receipt.read_text(encoding="utf-8"))
    assert rec["missingCells"] == []
    # Inventory maps never list formula cells, so `formulaCellsProtected` (formula
    # cells that were *mapped* for clearing) stays 0 by design.  The real guarantee
    # is that the workbook has formulas and every one survives unchanged.
    formula_cells = sum(s["formulaCount"] for s in data["sheets"])
    assert formula_cells > 0
    assert rec["formulaCellsProtected"] == 0

    assert_structure_preserved(src, out)
    assert sum(len(_formulas(ws)) for ws in openpyxl.load_workbook(out).worksheets) == formula_cells
    assert sha256(real_project["original"]) == real_project["before"]
    print("\nREAL_TEMPLATE_NUMBERS", json.dumps({
        "sheets": summary["sheets"], "entries": summary["entries"], "cleared": cleared["cleared"],
        "formulaCellsProtected": rec["formulaCellsProtected"], "ambiguousCount": rec["ambiguousCount"],
        "status": cleared["status"]}, ensure_ascii=False))
