"""audit C2: every text read/write must name encoding="utf-8"."""


from conftest import parse_json, run_gg

STRICT_ENC = {"PYTHONWARNDEFAULTENCODING": "1", "PYTHONWARNINGS": "error::EncodingWarning"}


def test_status_survives_default_encoding_warning_as_error(project):
    r = run_gg(project, "status", env=STRICT_ENC)
    assert r.returncode == 0, r.stderr
    assert parse_json(r.stdout)["revision"] == 1


def test_export_survives_default_encoding_warning_as_error(project):
    r = run_gg(project, "export", "--kind", "draft", env=STRICT_ENC)
    assert r.returncode == 0, r.stderr


def test_paper_writes_utf8_regardless_of_locale(project):
    spec = project / "paper.json"  # must live inside the project (core.local confinement)
    spec.write_text('{"title": "테스트 논문", "writing_year": 2026}', encoding="utf-8")
    r = run_gg(project, "paper", "--input", "paper.json", "--out", "build/본문.md",
               env={**STRICT_ENC, "PYTHONUTF8": "0"})
    assert r.returncode == 0, r.stdout + r.stderr
    out = project / "build" / "본문.md"
    out.read_bytes().decode("utf-8")
