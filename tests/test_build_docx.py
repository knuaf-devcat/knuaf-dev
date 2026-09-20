"""build_docx audit items: H2 (no landscape rotation), H3 (no silent drop between
TOC and body), manifest sidecar no-overwrite + staged write, LEVEL_PT vs the
school format probe."""
import json
from zipfile import ZipFile
from xml.etree import ElementTree as ET

import pytest

pytest.importorskip("docx")

from conftest import run_script

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

COVER = [
    "겉표지",
    "농업전문학사 학위논문",
    "영농창업계획",
    "시험 농장 영농창업계획",
    "2027년 2월",
    "한국농수산대학교",
    "특용작물전공",
    "홍길동",
    "",
]
APPROVAL = [
    "인준서",
    "홍길동의 농업전문학사 학위논문을 인준함",
    "2026년 12월",
    "위원장 김철수 (인)",
    "위  원 이영희 (인)",
    "위  원 박민수 (인)",
    "위  원 최지원 (인)",
    "",
]
TITLE_PAGE = [
    "표제면",
    "김교수 교수 지도",
    "농업전문학사 학위논문",
    "영농창업계획",
    "시험 농장 영농창업계획",
    "이 논문을 농업전문학사 학위논문으로 제출함",
    "2026년 12월",
    "한국농수산대학교",
    "특용작물전공",
    "홍길동",
    "",
]
SUBMISSION = ["제출서", "이 영농창업계획을 학교 양식에 따라 제출한다.", ""]
TOC = [
    "목차",
    "요약",
    "표 목차",
    "그림 목차",
    "Ⅰ. 머리말",
    "Ⅱ. 외부환경분석",
    "감사의 글",
    "",
]
BODY = [
    "Ⅰ. 머리말",
    "이 문단은 본문 산문이다. 학교 양식의 본문 글꼴과 줄간격을 검사하기 위한 문장이다.",
    "",
    "1. 중제목",
    "가. 소제목",
    "(1) 괄호 숫자 소제목",
    "괄호 숫자 소제목 아래 본문 문단이다.",
    "",
    "(가) 괄호 한글 소제목",
    "괄호 한글 소제목 아래 본문 문단이다.",
    "",
    "① 원문자 소제목",
    "원문자 소제목 아래 본문 문단이다.",
    "",
    "Ⅱ. 외부환경분석",
    "외부환경 본문 문단이다.",
    "",
    "감사의 글",
    "감사 문단이다.",
]


def school_md(order="legacy", between_toc_and_body=(), toc=TOC):
    if order == "legacy":
        parts = COVER + APPROVAL + TITLE_PAGE + SUBMISSION
    else:  # official form order: title page / submission / approval
        parts = COVER + TITLE_PAGE + SUBMISSION + APPROVAL
    return "\n".join(parts + list(toc) + list(between_toc_and_body) + BODY) + "\n"


def build(folder, md, out="build/out.docx", name="src.md"):
    (folder / name).write_text(md, encoding="utf-8")
    return run_script("build_docx.py", folder, "--in", name, "--out", out)


def page_sizes(docx_path):
    with ZipFile(docx_path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    sizes = []
    for sp in root.iter(W + "sectPr"):
        pg = sp.find(W + "pgSz")
        sizes.append((int(pg.get(W + "w")), int(pg.get(W + "h"))))
    return sizes


# ---------------------------------------------------------------- H2

def test_wide_table_never_rotates_section_to_landscape(empty_folder):
    header = ["구분"] + ["%d월" % m for m in range(1, 13)] + ["합계"]
    row = ["매출액"] + ["1,234,567,890"] * 13
    md = "\n".join([
        "Ⅰ. 머리말", "",
        "표 1. 넓은 표", "",
        "| " + " | ".join(header) + " |",
        "|" + "---|" * len(header),
        "| " + " | ".join(row) + " |",
        "", "표 다음 문단.",
    ]) + "\n"
    r = build(empty_folder, md)
    assert r.returncode == 0, r.stdout + r.stderr
    out = empty_folder / "build" / "out.docx"
    assert out.is_file()
    sizes = page_sizes(out)
    assert sizes and all(w < h for w, h in sizes), sizes
    manifest = json.loads(out.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    tl = manifest["table_layout"]
    assert tl["wide_tables_checked"] == 1
    assert tl["infeasible_count"] >= 1 or manifest["warnings"]
    assert tl["status"] == "infeasible_fit"
    assert not any(rep.get("rotated_to_landscape") for rep in tl["reports"])
    assert "경고" in r.stderr
    assert r.stdout.strip() == str(out)


# ---------------------------------------------------------------- H3

def test_content_between_toc_and_body_fails_closed_legacy_order(empty_folder):
    # Without a "감사의 글" TOC entry the body starts at the last "Ⅰ. 머리말",
    # so everything between the TOC lines and that heading is in the gap.
    toc = ["목차", "요약", "표 목차", "그림 목차", "Ⅰ. 머리말", "Ⅱ. 외부환경분석", ""]
    md = school_md("legacy", ["초록", "이 초록 문단은 목차 뒤에 있어 예전에는 조용히 버려졌다.", ""], toc=toc)
    r = build(empty_folder, md)
    assert r.returncode == 2, r.stdout + r.stderr
    assert "목차 뒤 렌더되지 않는 내용" in r.stdout
    assert "초록" in r.stdout
    assert not (empty_folder / "build" / "out.docx").exists()
    assert not (empty_folder / "build" / "out.manifest.json").exists()


def test_content_before_summary_anchor_fails_closed_official_order(empty_folder):
    toc = ["목차", "목차 앞 문단은 요약 절에도 들어가지 않는다.", "요약", "표 목차", "Ⅰ. 머리말", "감사의 글", ""]
    r = build(empty_folder, school_md("official", toc=toc))
    assert r.returncode == 2, r.stdout + r.stderr
    assert "목차 뒤 렌더되지 않는 내용" in r.stdout
    assert not (empty_folder / "build" / "out.docx").exists()


def test_summary_prose_after_anchor_is_rendered_official_order(empty_folder):
    toc = ["목차", "요약", "요약 절의 산문 문단은 요약 페이지에 출력된다.", "표 목차", "Ⅰ. 머리말", "감사의 글", ""]
    r = build(empty_folder, school_md("official", toc=toc))
    assert r.returncode == 0, r.stdout + r.stderr
    manifest = json.loads((empty_folder / "build" / "out.manifest.json").read_text(encoding="utf-8"))
    assert manifest["dropped_nodes"] == []
    with ZipFile(empty_folder / "build" / "out.docx") as z:
        xml = z.read("word/document.xml").decode("utf-8")
    assert "요약 절의 산문 문단" in xml


def test_plain_toc_entries_are_accepted(empty_folder):
    r = build(empty_folder, school_md("legacy"))
    assert r.returncode == 0, r.stdout + r.stderr
    manifest = json.loads((empty_folder / "build" / "out.manifest.json").read_text(encoding="utf-8"))
    assert manifest["dropped_nodes"] == []


# ---------------------------------------------------------------- manifest sidecar

def test_second_run_refuses_to_overwrite_docx_and_manifest(empty_folder):
    md = school_md("legacy")
    r1 = build(empty_folder, md)
    assert r1.returncode == 0, r1.stdout + r1.stderr
    out = empty_folder / "build" / "out.docx"
    manifest = out.with_suffix(".manifest.json")
    assert r1.stdout.strip() == str(out)
    before = (out.read_bytes(), manifest.read_bytes())

    r2 = build(empty_folder, md)
    assert r2.returncode == 2
    assert "기존 산출물을 덮어쓰지 않음" in r2.stdout
    assert (out.read_bytes(), manifest.read_bytes()) == before

    # A stale manifest alone must also block the run.
    out.unlink()
    r3 = build(empty_folder, md)
    assert r3.returncode == 2
    assert "기존 산출물을 덮어쓰지 않음" in r3.stdout
    assert not out.exists()
    assert manifest.read_bytes() == before[1]
    assert not list((empty_folder / "build").glob(".gg-tmp-*"))


# ---------------------------------------------------------------- LEVEL_PT

def test_sub_heading_sizes_pass_school_format_probe(empty_folder):
    import build_docx
    import gg_school_format

    assert all(build_docx.LEVEL_PT[lvl] >= 13 for lvl in (6, 7, 8, 9))
    r = build(empty_folder, school_md("official"))
    assert r.returncode == 0, r.stdout + r.stderr
    result = gg_school_format.check(empty_folder / "build" / "out.docx")
    size_violations = [v for v in result["violations"] if v.get("code") == "heading_size"]
    assert size_violations == [], size_violations
    assert result["heading_styles"]["sub"]["count"] >= 3
    assert not any(v.get("code") == "body_bookmark_missing" for v in result["violations"])


# --- 실패는 앱이 읽을 수 있는 모양이어야 한다 -----------------------------------

def test_a_failure_reports_in_the_envelope_shape(empty_folder):
    """앱은 stdout 의 JSON status/reason 또는 stderr 의 BLOCK: 만 읽는다(app/sidecar
    envelope.py). 평문으로 찍으면 화면에는 "만들기가 끝나지 않았어요" 제목만 남고
    이유가 사라진다 — GUI 감사 GUI-08 이 정확히 그것이었다. gg.py 는 이미 이 모양으로
    낸다; 생성기도 같은 계약을 지켜야 한다."""
    r = run_script("build_docx.py", empty_folder, "--in", "build/없는파일.md", "--out", "build/out.docx")
    assert r.returncode == 2, r.stdout + r.stderr
    payload = json.loads(r.stdout.strip().splitlines()[-1])
    assert payload["status"] == "blocked"
    assert "없는파일" in payload["reason"]
