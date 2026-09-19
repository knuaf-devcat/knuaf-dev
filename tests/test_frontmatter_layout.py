"""gg_frontmatter_layout: the school's fixed form bands, rendered to DOCX.

The cover, title page and approval page have fixed regions on the page. When
something does not fit, SKILL.md says the generator must not crop it — it must
say so ("제목이 양식 영역을 넘으면 잘라내지 않고 보완을 알린다"). These tests
hold the module to refusing rather than silently trimming, and to keeping lines
it has no slot for instead of dropping them.
"""
import pytest

pytest.importorskip("docx")

from docx import Document

from gg_document import parse, school_frontmatter_plan
from gg_frontmatter import frontmatter_lines, normalize_school_profile
import gg_frontmatter_layout as fl

BASE = {
    "mode": "school", "title": "도라지 재배 창업계획", "author": "홍길동",
    "department": "특용작물전공", "advisor": "김교수",
    "submission_date": "2026년 12월", "graduation_date": "2027년 2월",
    "committee": {"chair": "박교수", "members": ["이교수", "최교수", "정교수"]},
}


def render(**over):
    """Drive the real path build_docx uses: lines → parse → plan → render."""
    profile = normalize_school_profile({"school_profile": {**BASE, **over}})
    text = "\n\n".join(frontmatter_lines(profile)) + "\n\n목차\n\nⅠ. 머리말\n\n본문\n"
    nodes = parse(text)
    doc = Document()
    fl.render_forms(doc, nodes, school_frontmatter_plan(nodes), "신명조")
    return doc


def all_text(doc):
    """The forms nest tables inside cells (the signature block is one), so a
    single-level walk silently misses them."""
    out = [p.text for p in doc.paragraphs]

    def walk(table):
        for row in table.rows:
            for cell in row.cells:
                out.extend(p.text for p in cell.paragraphs)
                for nested in cell.tables:
                    walk(nested)

    for t in doc.tables:
        walk(t)
    return "\n".join(out)


# --- measurement: Korean is full width, ASCII is not --------------------------

def test_a_korean_character_counts_as_one_band_unit():
    doc = render()
    assert "도라지 재배 창업계획" in all_text(doc)


# --- the ordinary case --------------------------------------------------------

def test_a_normal_profile_renders_the_three_forms():
    text = all_text(render())
    for value in ("도라지 재배 창업계획", "홍길동", "특용작물전공",
                  "한국농수산대학교", "농업전문학사 학위논문"):
        assert value in text, value


def test_the_advisor_and_committee_reach_the_page():
    text = all_text(render())
    assert "김교수" in text
    for member in ("박교수", "이교수", "최교수", "정교수"):
        assert member in text, member


def test_both_dates_reach_the_page_without_being_merged():
    text = all_text(render())
    assert "2026년 12월" in text and "2027년 2월" in text


# --- too long is refused, never cropped ---------------------------------------

def test_a_title_that_overflows_its_band_is_refused_not_trimmed():
    """SKILL.md: 제목이 양식 영역을 넘으면 잘라내지 않고 보완을 알린다."""
    with pytest.raises(ValueError, match="표지 제목/부제가 허용 영역을 초과"):
        render(title="가" * 200)


def test_the_refusal_says_what_to_do():
    with pytest.raises(ValueError, match="제목을 줄이거나 별도 양식 프로필"):
        render(title="가" * 200)


def test_a_title_that_still_fits_is_kept_whole():
    """Pairs with the refusal: the long-but-valid title is not shortened."""
    title = "도라지 및 더덕 복합재배를 통한 산지형 특용작물 창업 영농계획 수립"
    assert title in all_text(render(title=title))


@pytest.mark.parametrize("field,limit", [("department", 22), ("author", 22)])
def test_a_single_line_field_that_overflows_is_refused(field, limit):
    with pytest.raises(ValueError, match="한 줄 필드가 너무 김"):
        render(**{field: "가" * (limit + 1)})


@pytest.mark.parametrize("field,limit", [("department", 22), ("author", 22)])
def test_a_single_line_field_exactly_at_the_limit_is_accepted(field, limit):
    """The boundary is inclusive; one more unit is what fails."""
    value = "가" * limit
    assert value in all_text(render(**{field: value}))


def test_an_advisor_line_that_overflows_is_refused():
    with pytest.raises(ValueError, match="지도교수 표시가 학교 양식의 한 줄 영역을 초과"):
        render(advisor="가" * 24)


# --- structure the form depends on --------------------------------------------

def test_a_truncated_frontmatter_yields_no_plan_at_all():
    """The guard is upstream: no plan means build_docx takes the legacy path
    instead of rendering a half-empty cover (build_docx.py:319 `if front_plan`)."""
    nodes = parse("겉표지\n\n농업전문학사 학위논문\n\n목차\n\nⅠ. 머리말\n\n본문\n")
    assert school_frontmatter_plan(nodes) is None


def test_a_complete_frontmatter_yields_a_plan_with_every_form():
    profile = normalize_school_profile({"school_profile": BASE})
    text = "\n\n".join(frontmatter_lines(profile)) + "\n\n목차\n\nⅠ. 머리말\n\n본문\n"
    plan = school_frontmatter_plan(parse(text))
    assert plan is not None
    for form in ("겉표지", "표제면", "제출서", "인준서", "목차"):
        assert form in plan["indices"], form


def test_more_than_two_title_paragraphs_are_refused():
    profile = normalize_school_profile({"school_profile": BASE})
    lines = frontmatter_lines(profile)
    # cover[2:-4] is the title region; one extra line is a legal subtitle,
    # so two extras are needed to exceed "제목 1 + 부제 1".
    at = lines.index("겉표지") + 4
    lines[at:at] = ["군더더기 제목 줄 1", "군더더기 제목 줄 2"]
    text = "\n\n".join(lines) + "\n\n목차\n\nⅠ. 머리말\n\n본문\n"
    nodes = parse(text)
    with pytest.raises(ValueError, match="제목과 부제는 각 한 문단"):
        fl.render_forms(Document(), nodes, school_frontmatter_plan(nodes), "신명조")


# --- lines with no slot are shown, not dropped --------------------------------

def test_an_unassigned_line_is_kept_on_the_page():
    """양식 슬롯에 배정되지 않은 저작 행을 조용히 버리지 않는다."""
    profile = normalize_school_profile({"school_profile": BASE})
    lines = frontmatter_lines(profile)
    note = "검토 메모: 지도교수 확인 대기"
    lines.insert(lines.index("인준서"), note)
    text = "\n\n".join(lines) + "\n\n목차\n\nⅠ. 머리말\n\n본문\n"
    nodes = parse(text)
    doc = Document()
    fl.render_forms(doc, nodes, school_frontmatter_plan(nodes), "신명조")
    assert note in all_text(doc), "슬롯 없는 행이 사라짐"


def test_an_unassigned_block_that_overflows_is_refused_rather_than_dropped():
    profile = normalize_school_profile({"school_profile": BASE})
    lines = frontmatter_lines(profile)
    lines.insert(lines.index("인준서"), "가" * 200)
    text = "\n\n".join(lines) + "\n\n목차\n\nⅠ. 머리말\n\n본문\n"
    nodes = parse(text)
    with pytest.raises(ValueError, match="초과"):
        fl.render_forms(Document(), nodes, school_frontmatter_plan(nodes), "신명조")


# --- the contents page carries real page references ---------------------------

def test_the_contents_uses_page_reference_fields_not_typed_numbers():
    """Typed page numbers go stale the moment the body grows."""
    doc = Document()
    fl.contents(doc, [("Ⅰ. 머리말", "gg_body_1", 1)], "신명조")
    xml = doc.element.xml
    assert "PAGEREF gg_body_1" in xml
    assert "fldSimple" in xml


def test_a_bookmark_is_written_with_the_name_the_contents_points_at():
    doc = Document()
    p = doc.add_paragraph("Ⅰ. 머리말")
    fl.bookmark(p, "gg_body_1", 9001)
    xml = doc.element.xml
    assert 'w:name="gg_body_1"' in xml
    assert "bookmarkStart" in xml and "bookmarkEnd" in xml
