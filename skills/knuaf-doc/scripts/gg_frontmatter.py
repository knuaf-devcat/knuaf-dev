"""Normalize optional KNUAF school frontmatter metadata.

The school paper generator historically accepted flat metadata keys.  This
module adds an explicit, opt-in ``school_profile`` object while retaining that
legacy contract.  It deliberately does not manufacture identities, dates, or
approval state: missing values are represented by ``[확인 필요]`` for visible
planning fields and by an empty approval name in the renderer.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping

PENDING = "[확인 필요]"
SUPPORTED = {
    "mode",
    "degree",
    "plan_label",
    "title",
    "subtitle",
    "school",
    "department",
    "major",
    "author",
    "student",
    "advisor",
    "submission_date",
    "submitted",
    "graduation_date",
    "committee",
    "committee_chair",
    "committee_members",
    "unknown_policy",
    "layout",
}


def _text(value: Any) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _first(profile: Mapping[str, Any], spec: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _text(profile.get(key))
        if value is None:
            value = _text(spec.get(key))
        if value is not None:
            return value
    return None


def normalize_school_profile(spec: Mapping[str, Any]) -> dict[str, Any]:
    """Return a validated, detached profile for an opt-in school document.

    ``school_profile`` may be omitted; callers can use the returned
    ``enabled`` flag to preserve the historical flat-key output.  Nested
    values take precedence over legacy keys.  ``submission_date`` and
    ``graduation_date`` are intentionally independent and are never copied
    from one another.
    """

    if not isinstance(spec, Mapping):
        raise TypeError("학교 프로필은 객체여야 함")
    raw = spec.get("school_profile")
    if raw is None:
        return {"enabled": False}
    if not isinstance(raw, Mapping):
        raise TypeError("school_profile은 객체여야 함")
    unknown = sorted(set(raw) - SUPPORTED)
    if unknown:
        raise ValueError("지원하지 않는 school_profile 키: " + ", ".join(unknown))

    committee = raw.get("committee")
    if committee is None:
        committee = {}
    if not isinstance(committee, Mapping):
        raise TypeError("school_profile.committee는 객체여야 함")
    committee_unknown = sorted(
        set(committee) - {"chair", "members", "committee_chair", "committee_members"}
    )
    if committee_unknown:
        raise ValueError(
            "지원하지 않는 school_profile.committee 키: " + ", ".join(committee_unknown)
        )
    chair = _first(committee, raw, "chair", "committee_chair")
    members = committee.get("members", raw.get("committee_members"))
    if members is None:
        members_list: list[str | None] = []
    elif isinstance(members, (list, tuple)):
        members_list = [_text(x) for x in members]
    else:
        raise TypeError("school_profile.committee.members는 목록이어야 함")
    if len(members_list) > 3:
        raise ValueError("위원은 위원장 포함 4명 형식이므로 위원 3명까지 허용")
    members_list.extend([None] * (3 - len(members_list)))

    policy = _text(raw.get("unknown_policy")) or "mark"
    if policy != "mark":
        raise ValueError("unknown_policy는 mark만 지원함; 미확인 인적사항은 표시하고 서명 이름은 빈칸으로 유지")
    mode = _text(raw.get("mode")) or "school"
    if mode != "school":
        raise ValueError("school_profile.mode는 school이어야 함")
    layout = _text(raw.get("layout")) or "forms_1_to_4"
    if layout not in {"forms_1_to_4", "logical_legacy"}:
        raise ValueError("layout은 forms_1_to_4 또는 logical_legacy여야 함")
    return {
        "enabled": True,
        "mode": mode,
        "layout": layout,
        "source_order_note": (
            "공식 지침 p4 논리 순서와 p6–9 시각 예시 순서가 달라 forms_1_to_4를 선택함"
            if layout == "forms_1_to_4"
            else "공식 지침 p4 논리 순서를 선택함; p6–9 시각 예시와 순서가 다를 수 있어 사용자 검토 필요"
        ),
        "degree": _first(raw, spec, "degree") or "농업전문학사 학위논문",
        "plan_label": _first(raw, spec, "plan_label") or "영농창업계획",
        "title": _first(raw, spec, "title"),
        "subtitle": _first(raw, spec, "subtitle"),
        "school": _first(raw, spec, "school") or "한국농수산대학교",
        "department": _first(raw, spec, "department", "major"),
        "author": _first(raw, spec, "author", "student"),
        "advisor": _first(raw, spec, "advisor"),
        "submission_date": _first(raw, spec, "submission_date", "submitted"),
        # Deliberately independent of submission_date; no fallback copying.
        "graduation_date": _first(raw, spec, "graduation_date"),
        "committee": {"chair": chair, "members": members_list},
        "unknown_policy": policy,
    }


def display(value: str | None, profile: Mapping[str, Any], *, blank: bool = False) -> str:
    """Render a profile value without silently inventing data."""

    if value:
        return value
    if blank or profile.get("unknown_policy") == "blank":
        return ""
    return PENDING


def frontmatter_lines(profile: Mapping[str, Any], *, artifacts: Mapping[str, Any] | None = None) -> list[str]:
    """Build logical Markdown lines in official form order.

    The renderer keeps ``표제면`` and ``제출서`` as separate logical markers;
    the DOCX renderer may place them on the same physical page.  This keeps the
    parser and legacy export stable while representing the three visible forms
    (cover, title/submission, approval) before the TOC.
    """

    if not profile.get("enabled"):
        raise ValueError("frontmatter_lines에는 활성 학교 프로필이 필요")
    author = display(profile.get("author"), profile)
    title = display(profile.get("title"), profile)
    department = display(profile.get("department"), profile)
    school = display(profile.get("school"), profile)
    advisor = display(profile.get("advisor"), profile)
    submission = display(profile.get("submission_date"), profile)
    graduation = display(profile.get("graduation_date"), profile)
    plan = display(profile.get("plan_label"), profile)
    degree = display(profile.get("degree"), profile)
    chair = profile["committee"].get("chair")
    members = profile["committee"].get("members", [])
    # Empty names keep the signature line visibly unsigned.  A non-empty
    # unknown marker remains explicit for a supplied-but-unresolved name.
    chair_display = display(chair, profile, blank=True)
    member_display = [display(x, profile, blank=True) for x in members]

    cover = [
        "겉표지",
        degree,
        plan,
        title,
    ]
    subtitle = profile.get("subtitle")
    if subtitle:
        cover.append(str(subtitle).strip())
    cover += [graduation, school, department, author, ""]
    title_page = ["표제면", "지도교수 " + advisor,
              degree, plan] + ([str(subtitle).strip()] if subtitle else []) + [title, "이 논문을 " + degree + "으로 제출함", submission,
              school, department, author, "", "제출서",
              "이 영농창업계획을 학교 양식에 따라 제출한다.", ""]
    approval = ["인준서",
              author + "의 농업전문학사 학위논문을 인준함", submission,
              "위원장 " + chair_display + " (인)"]
    approval.extend("위  원 " + name + " (인)" for name in member_display)
    lines = cover + (title_page + approval if profile.get("layout") == "forms_1_to_4" else approval + title_page)
    lines += ["", "목차"]
    if artifacts:
        for key, label in (("summary", "요약"), ("table_list", "표 목차"), ("figure_list", "그림 목차")):
            if artifacts.get(key):
                lines.append(label)
    return lines
