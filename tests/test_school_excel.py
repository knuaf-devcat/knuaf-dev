"""audit H7: a broken xlsx must not crash inspect_outputs()."""
import pytest

pytest.importorskip("openpyxl")
import gg_core as core
import gg_school_excel


def test_zero_byte_xlsx_output_is_reported_not_raised(project):
    (project / "build").mkdir(exist_ok=True)
    (project / "build" / "broken.xlsx").write_bytes(b"")
    p = core.load(project)
    p["outputs"]["out-broken"] = {
        "id": "out-broken", "revision": 1, "format": "xlsx", "path": "build/broken.xlsx",
        "target_refs": [], "input_fingerprint": "x", "file_hash": "x", "checks": [],
    }
    issues = gg_school_excel.inspect_outputs(project, p)
    assert any(cid == "school_excel_17" for cid, _ in issues)
