"""gg_finance.workbook: staged save + no-overwrite for both the XLSX and its
manifest sidecar (audit: unguarded manifest write next to a guarded xlsx)."""
import json

import pytest

pytest.importorskip("openpyxl")

from conftest import run_script

SPEC = {
    "profile": "single_annual_cash_v1",
    "crops": ["딸기"],
    "accounting_basis": "cash_pre_tax_no_inventory",
    "source_refs": ["answers.md#재무"],
    "unit": "원",
    "quantity_unit": "kg",
    "land": "10000000",
    "facility": "20000000",
    "equity": "25000000",
    "loan": "10000000",
    "loan_rate": "0.02",
    "discount_rate": "0.05",
    "salvage": "2000000",
    "start_year": 2027,
    "years": 2,
    "life": 2,
    "grace": 0,
    "term": 2,
    "repayment": "equal_principal",
    "investment_basis": "school_farm_new_business",
    "owner_labor_in_costs": False,
    "periods": [
        {"year": 2027, "quantity": "1000", "sold": "1000", "loss": "0",
         "price": "15000", "variable_cost": "3000", "fixed_cost": "2000000",
         "household": "3000000"},
        {"year": 2028, "quantity": "1200", "sold": "1200", "loss": "0",
         "price": "15000", "variable_cost": "3000", "fixed_cost": "2000000",
         "household": "3000000"},
    ],
}


def run(folder, out="build/fin.xlsx"):
    (folder / "spec.json").write_text(json.dumps(SPEC, ensure_ascii=False), encoding="utf-8")
    return run_script("build_excel_finance_template.py", folder, "--input", "spec.json", "--out", out)


def test_workbook_and_manifest_written_once_then_refused(empty_folder):
    r1 = run(empty_folder)
    assert r1.returncode == 0, r1.stdout + r1.stderr
    assert json.loads(r1.stdout)["status"] == "calculated"
    xlsx = empty_folder / "build" / "fin.xlsx"
    manifest = empty_folder / "build" / "fin.manifest.json"
    assert xlsx.is_file() and manifest.is_file()
    assert not list((empty_folder / "build").glob(".gg-tmp-*"))
    before = (xlsx.read_bytes(), manifest.read_bytes())
    assert json.loads(before[1].decode("utf-8"))["file_hash"]

    r2 = run(empty_folder)
    assert r2.returncode == 2
    assert "덮어쓰" in json.loads(r2.stdout)["reason"]
    assert (xlsx.read_bytes(), manifest.read_bytes()) == before


def test_stale_manifest_alone_blocks_save(empty_folder):
    import gg_finance

    out = empty_folder / "build" / "fin.xlsx"
    out.parent.mkdir()
    stale = out.with_suffix(".manifest.json")
    stale.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="기존 산출물을 덮어쓰지 않음"):
        gg_finance.workbook(SPEC, out)
    assert not out.exists()
    assert stale.read_text(encoding="utf-8") == "{}"
    assert not list(out.parent.glob(".gg-tmp-*"))
