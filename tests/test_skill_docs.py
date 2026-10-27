"""SKILL.md is the only entry point, so every reference must be one hop away
and every referenced file must exist. Both broke silently before."""
import re

from conftest import REPO

SKILL_DIR = REPO / "skills" / "knuaf-dev"
SKILL = SKILL_DIR / "SKILL.md"
REFS = SKILL_DIR / "references"

# Structural pointers only: markdown link targets, plus any references/* path in
# backticks. Working-folder example paths (sources/, build/, migration/) name files
# a student project creates at runtime, not files that ship with the skill.
MD_LINK = re.compile(r"\]\(([^)]+\.md)\)")
REF_MENTION = re.compile(r"`(references/[\w./*-]+\.md)`")


def skill_docs():
    return [SKILL] + sorted(REFS.glob("*.md"))


def test_every_reference_is_linked_from_skill_md():
    body = SKILL.read_text(encoding="utf-8")
    orphans = [p.name for p in REFS.glob("*.md") if p.name not in body]
    assert not orphans, "not reachable in one hop from SKILL.md: %s" % orphans


def test_no_dangling_markdown_reference():
    missing = []
    for doc in skill_docs():
        text = doc.read_text(encoding="utf-8")
        for raw in MD_LINK.findall(text) + REF_MENTION.findall(text):
            if raw.startswith("http") or "*" in raw:
                continue
            target = (SKILL_DIR / raw) if raw.startswith("references/") else (doc.parent / raw)
            if not target.exists() and not (SKILL_DIR / raw).exists():
                missing.append("%s -> %s" % (doc.name, raw))
    assert not missing, "referenced but absent: %s" % missing


def test_retired_flat_file_ledger_is_gone():
    """project.json is the only canon; the old parallel ledger must not return."""
    retired = ("00_config.md", "00_interview.md", "00_interview_log.md",
               "01_assumptions.md", "02_receipts.jsonl", "03_sources.md",
               "04_research_log.md")
    hits = []
    for path in list(skill_docs()) + sorted((SKILL_DIR / "scripts").glob("*.py")):
        text = path.read_text(encoding="utf-8")
        hits += ["%s: %s" % (path.name, name) for name in retired if name in text]
    assert not hits, hits


def test_no_host_specific_model_names():
    """Routing is by role; concrete model ids belong to the host, not the skill."""
    banned = ("gpt-5.6-luna", "Luna xhigh", "spawn_agent", "fork_turns")
    hits = []
    for doc in skill_docs():
        text = doc.read_text(encoding="utf-8")
        hits += ["%s: %s" % (doc.name, b) for b in banned if b in text]
    assert not hits, hits


# The makers' names are an app-opening-screen marking, not skill text. The helper writes
# its first reply from this skill, so a name left here is a name it reads out — it did.
MAKER_MARK = ("김대욱", "이준재", "특용작물전공 24학번", "산업곤충전공 24학번")


def test_skill_text_carries_no_maker_names():
    hits = []
    for doc in skill_docs():
        text = doc.read_text(encoding="utf-8")
        hits += ["%s: %s" % (doc.name, m) for m in MAKER_MARK if m in text]
    assert not hits, hits


def test_first_entry_still_names_the_tool_and_the_save_location():
    """Dropping the names must not drop the rest of the first-entry notice — for a
    terminal-only user this sentence is the only place the tool identifies itself."""
    head = SKILL.read_text(encoding="utf-8").split("## 시작·재개")[0]
    assert "KNUAF-Dev · 창업논문 작성 도우미" in head
    assert "저장 위치" in head


# The app-side AI writes facts from the allowed values it reads in the reference docs.
# A value outside the core set is rejected, so a doc list that drifted from the code
# blocks fact registration with no way to see why. The skill here is a copy of
# starceas/knuaf-doc, so this test must fail if that copy brings back a stale list.
FACT_ENUMS = (("kind", "KINDS"), ("answer_state", "STATES"), ("verification", "VERIFY"))


def test_fact_allowed_values_in_docs_match_the_core():
    import gg_core as core

    text = (REFS / "mid-work-questions.md").read_text(encoding="utf-8")
    bad = []
    for field, const in FACT_ENUMS:
        line = re.search(r"^- `%s` 허용값: (.+)$" % field, text, re.M)
        if line is None:
            bad.append("%s: 허용값 줄 없음" % field)
            continue
        listed = {v.strip().strip("`") for v in line.group(1).split("/")}
        actual = getattr(core, const)
        if listed != actual:
            bad.append("%s: 문서 %s != 코어 %s" % (field, sorted(listed), sorted(actual)))
    assert not bad, bad
