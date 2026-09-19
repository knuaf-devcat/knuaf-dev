"""gg_frontmatter: the cover, title and approval pages a student sees first.

The module's own docstring says it "deliberately does not manufacture
identities, dates, or ..." — these tests hold it to that. A thesis cover
carrying an invented name, a guessed submission date, or a graduation date
copied from the submission date is worse than one that says 확인 필요.
"""
import pytest

import gg_frontmatter as fm


def profile(**school):
    return fm.normalize_school_profile({"school_profile": {"mode": "school", **school}})


# --- the opt-in boundary ------------------------------------------------------

def test_a_spec_without_a_school_profile_keeps_the_legacy_path():
    """Flat-key documents must keep working; the profile is opt-in."""
    assert fm.normalize_school_profile({"title": "t", "student": "홍길동"}) == {"enabled": False}


def test_a_school_profile_turns_the_new_form_on():
    assert profile(title="테스트")["enabled"] is True


@pytest.mark.parametrize("bad", ["문자열", 5, [], True])
def test_a_non_object_spec_or_profile_is_refused(bad):
    with pytest.raises(TypeError):
        fm.normalize_school_profile(bad)
    with pytest.raises(TypeError):
        fm.normalize_school_profile({"school_profile": bad})


# --- unknown keys are refused, not ignored ------------------------------------

def test_an_unrecognised_profile_key_is_refused():
    """Silently dropping a key would lose data the student supplied."""
    with pytest.raises(ValueError, match="지원하지 않는 school_profile 키"):
        fm.normalize_school_profile({"school_profile": {"mode": "school", "저자": "홍길동"}})


def test_an_unrecognised_committee_key_is_refused():
    with pytest.raises(ValueError, match="committee 키"):
        profile(committee={"위원장": "김교수"})


@pytest.mark.parametrize("members", ["홍길동", 5, {"a": 1}])
def test_committee_members_must_be_a_list(members):
    with pytest.raises(TypeError, match="members는 목록"):
        profile(committee={"members": members})


def test_a_non_object_committee_is_refused():
    with pytest.raises(TypeError, match="committee는 객체"):
        profile(committee="김교수")


# --- the two dates never borrow from each other -------------------------------

def test_a_submission_date_does_not_become_a_graduation_date():
    """SKILL.md: 제출일과 졸업일을 임의로 복제하지 않는다."""
    p = profile(submission_date="2026년 12월")
    assert p.get("submission_date") == "2026년 12월"
    assert p.get("graduation_date") is None


def test_a_graduation_date_does_not_become_a_submission_date():
    p = profile(graduation_date="2027년 2월")
    assert p.get("graduation_date") == "2027년 2월"
    assert p.get("submission_date") is None


def test_both_dates_are_kept_when_both_are_given():
    p = profile(submission_date="2026년 12월", graduation_date="2027년 2월")
    assert p["submission_date"] == "2026년 12월"
    assert p["graduation_date"] == "2027년 2월"


# --- unknown identities are marked, never blanked -----------------------------

def test_the_only_policy_is_to_mark_unknown_identities():
    """`blank` would hide a missing name; the school form must show 확인 필요."""
    assert profile()["unknown_policy"] == "mark"
    for refused in ("blank", "hide", "omit"):
        with pytest.raises(ValueError, match="unknown_policy"):
            profile(unknown_policy=refused)


def test_display_marks_a_missing_value():
    assert fm.display(None, profile()) == fm.PENDING == "[확인 필요]"
    assert fm.display("", profile()) == fm.PENDING


def test_display_keeps_a_supplied_value():
    assert fm.display("홍길동", profile()) == "홍길동"


def test_a_signature_line_is_blank_on_purpose():
    """A signature is signed by hand; printing 확인 필요 on the line is wrong."""
    assert fm.display(None, profile(), blank=True) == ""


# --- whitespace is not a value ------------------------------------------------

@pytest.mark.parametrize("empty", ["", "   ", "\t", None])
def test_a_blank_field_is_treated_as_missing_not_as_text(empty):
    p = profile(student=empty)
    assert fm.display(p.get("student"), p) == fm.PENDING


def test_values_are_trimmed():
    assert profile(author="  홍길동  ")["author"] == "홍길동"


def test_the_legacy_student_key_still_fills_the_author_slot():
    """Older specs say `student`; the form prints one author either way."""
    assert profile(student="홍길동")["author"] == "홍길동"
    assert profile(author="이몽룡", student="홍길동")["author"] == "이몽룡"


def test_the_committee_keeps_three_signature_slots():
    """The approval form has a fixed number of lines whether or not they are
    filled — dropping empty ones would change the school's form."""
    p = profile()
    assert p["committee"]["chair"] is None
    assert len(p["committee"]["members"]) == 3


def test_supplied_committee_members_are_kept_in_order():
    p = profile(committee={"chair": "김교수", "members": ["이교수", "박교수", "최교수"]})
    assert p["committee"]["chair"] == "김교수"
    assert p["committee"]["members"] == ["이교수", "박교수", "최교수"]


def test_the_fixed_school_strings_are_not_overridable_by_omission():
    p = profile()
    assert p["school"] == "한국농수산대학교"
    assert p["degree"] == "농업전문학사 학위논문"
    assert p["plan_label"] == "영농창업계획"


# --- the rendered forms -------------------------------------------------------

def test_the_three_official_forms_appear_before_the_contents():
    lines = fm.frontmatter_lines(profile(title="테스트 논문"))
    for marker in ("겉표지", "표제면", "인준서"):
        assert marker in lines, marker
    assert lines.index("겉표지") < lines.index("표제면") < lines.index("인준서")


def test_the_school_name_is_fixed_and_the_rest_is_marked():
    lines = fm.frontmatter_lines(profile(title="테스트 논문"))
    assert "한국농수산대학교" in lines
    assert "테스트 논문" in lines
    assert lines.count(fm.PENDING) >= 3, "미제공 항목이 표시되지 않음"


def test_nothing_in_the_forms_is_invented():
    """Every line is either a fixed school string, a supplied value, the
    pending marker, or empty — never a guess."""
    supplied = {"title": "테스트 논문", "student": "홍길동", "advisor": "김교수"}
    lines = fm.frontmatter_lines(profile(**supplied))
    for line in lines:
        assert not _looks_like_a_guessed_date(line), line


def _looks_like_a_guessed_date(line):
    import re
    return bool(re.search(r"20\d{2}\s*년\s*\d{1,2}\s*월", line))


def test_a_supplied_date_does_appear():
    """Pairs with the test above: the date is absent because it was not given."""
    lines = fm.frontmatter_lines(profile(title="t", submission_date="2026년 12월"))
    assert any("2026년 12월" in line for line in lines)
