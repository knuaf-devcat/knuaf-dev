"""`section.read_all` — 등록 순서대로 절 본문을 한 번에 돌려주는 읽기 전용 메서드.

종이 칸이 처음 그려질 때 절마다 `section.read` 를 부르면 호출이 N번이 된다. 사이드카가
`section_read` 를 등록 순서대로 반복할 뿐이므로 pytest 1개로 잠근다(발주 ④).
"""
import pytest

from conftest import write_section
from test_sidecar import Sidecar


@pytest.fixture
def sidecar():
    s = Sidecar()
    yield s
    s.close()


def test_read_all_is_read_only_and_matches_read_in_registration_order(sidecar, project):
    import gg_core as core

    write_section(project, "sections/02.md", "Ⅱ. 농장 소개", "새벽빛 농원은 해 뜨기 전에 딴다.")
    write_section(project, "sections/03.md", "Ⅲ. 경영 현황", "재배 면적은 3,300㎡이다.")
    core.apply(project, {
        "request_id": "test:read-all:1",
        "ops": [
            {"collection": "sections", "value": {"id": "sec-03", "title": "Ⅲ. 경영 현황", "order": 3, "path": "sections/03.md", "status": "drafting"}},
            {"collection": "sections", "value": {"id": "sec-02", "title": "Ⅱ. 농장 소개", "order": 2, "path": "sections/02.md", "status": "drafting"}},
        ],
    }, 1)

    flags = {m["name"]: m["write"] for m in sidecar.call("methods.list")["result"]}
    assert flags["section.read_all"] is False

    rows = sidecar.ok("section.read_all", root=str(project))["result"]
    assert [r["id"] for r in rows] == ["sec-01", "sec-02", "sec-03"]
    assert [r["id"] for r in rows] == [r["id"] for r in sidecar.call("project.sections", root=str(project))["result"]]
    assert "3,300" in rows[2]["draft"]
    assert rows[2]["path"] == "sections/03.md" and rows[2]["title"] == "Ⅲ. 경영 현황"

    for row in rows:
        assert row == sidecar.ok("section.read", root=str(project), id=row["id"])["result"]
