"""Supported Markdown: headings, paragraphs, pipe tables, local images, emphasis."""

import re
from pathlib import Path
from gg_core import draft

# 학명 이탤릭은 이명법(속명+종소명)+명명자/등급 표지가 함께 나오는 경우만
# 적용한다. 종소명 자리의 영어 기능어(전치사·접속사·관사·조동사·대명사·흔한
# 부사/연결어)와, 명명자가 없는 "Growth response"·"Soil moisture" 같은 일반
# 영어 명사구를 학명으로 오인하지 않는다. 명명자 없는 학명은 로마체로 남으며
# 학명 검토는 여전히 사람 검토 대상이다.
_SCI_FUNCTION_WORDS = (
    "about above across after again against along although among and another "
    "any are around because been before behind being below beneath beside "
    "besides between beyond both but can could did does down during each "
    "either else even every except few for from had has have having hence her "
    "here how however in inside instead into its just least less like many "
    "may might more most much must near neither never next nor not now off "
    "once one only onto or other ought our out outside over own past per "
    "quite rather really same shall should since so some still such than that "
    "the their them then there therefore these they this those though through "
    "throughout thus till to too toward towards under underneath unless until "
    "unto up upon very via was were what when where which while who whom "
    "whose will with within without would yet you your"
).split()
SCI = re.compile(
    r"\b([A-Z][a-z]{2,}|[A-Z]\.)\s+((?!(?:"
    + "|".join(sorted(set(_SCI_FUNCTION_WORDS)))
    + r")\b)[a-z]{3,})(?=\s+(?:[A-Z][a-z]*\.?|var\.|subsp\.|f\.|ex\b|×))"
)
CAPTION = re.compile(r"^\s*(표|그림)\s*(\d+)\s*\.\s*(.+)$")
IMAGE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)$")
CLIMATE = [
    "평균기온",
    "최고기온",
    "최저기온",
    "강우량",
    "평균적설량",
    "최고적설량",
    "주된풍향",
    "평균풍속",
    "최대풍속",
]
CLIMATE_FOOTER = ["관측장소", "최근 5개년 평균", "초상일", "만상일"]
DISASTER_FREQ = ("가장 자주 발생", "자주 발생", "가끔 발생")
DISASTER_TYPES = ("한발", "홍수", "태풍", "공장폐수", "공해가스", "야생동물")
FARM_MARKERS = ("농장명",)

# 세 어휘 검사는 식별 가능한 힌트일 뿐이며 "단어 없음=내용 부족 확정"이
# 아니다. 의미 충족 판정은 독립 내용검토·지침 계약의 소유다. 코어
# (gg_core)는 이 집합에 든 ID만 warning으로 집계하고 구조·수치·자료
# 누락 오류는 여기에 넣지 않는다.
CONTENT_REVIEW_HINTS = frozenset(
    {"intro_topics", "closing_elements", "process_plan"}
)


def _norm_cell(s):
    return re.sub(r"\s+", "", s)


# 빈 값·미제공·미산정 표시는 채워진 자료 셀로 세지 않는다.
_EMPTY_CELL = frozenset(
    _norm_cell(x)
    for x in (
        "-", "—", "–", "―", "·", "…", "확인 필요", "[확인 필요]",
        "미산정", "자료 없음", "해당 없음", "없음", "없다", "N/A",
        # pipe-table merge markers (gg_school_paper climate/profile tables)
        "<", "^",
    )
)


def _filled_cell(cell):
    return _norm_cell(cell) not in _EMPTY_CELL


def _field_filled(rows, pattern):
    """항목 라벨 셀이 있고 같은 행(첫 열 라벨) 또는 같은 열(머리 셀)에
    채워진 자료 셀이 하나라도 있으면 참. 라벨만 있고 값이 비어 있으면
    미제공 항목이다."""
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            if not pattern.search(cell):
                continue
            if c == 0:
                if any(_filled_cell(x) for x in row[1:]):
                    return True
            elif any(
                _filled_cell(rows[r2][c])
                for r2 in range(r + 1, len(rows))
                if c < len(rows[r2])
            ):
                return True
    return False


# 학교 양식 항목과 명백히 같은 뜻의 표기만 인정한다. 임의 동의어 사전이나
# 의미 추론은 두지 않는다.
CLIMATE_PATTERNS = {
    "평균기온": re.compile(r"평균\s*기온"),
    "최고기온": re.compile(r"최고\s*기온"),
    "최저기온": re.compile(r"최저\s*기온"),
    "강우량": re.compile(r"강우량|강수량"),
    "평균적설량": re.compile(r"평균\s*적설량"),
    "최고적설량": re.compile(r"최고\s*적설량"),
    "주된풍향": re.compile(r"풍향"),
    "평균풍속": re.compile(r"평균\s*풍속"),
    "최대풍속": re.compile(r"최대\s*풍속"),
}
# 각주 항목 라벨(표 안쪽 행)과, 표 바로 아래 주·자료 문맥에서 같은 정보를
# 적은 표현을 구분한다. 문맥 쪽에는 평균 기간의 연 범위 표기를 포함한다.
CLIMATE_FOOTER_LABEL = {
    "관측장소": re.compile(r"관측장소|관측지점|관측소|좌표"),
    "최근 5개년 평균": re.compile(r"5\s*개년|최근\s*5\s*년"),
    "초상일": re.compile(r"초상일|첫\s*서리|처음\s*서리"),
    "만상일": re.compile(r"만상일|늦\s*서리|마지막\s*서리"),
}
CLIMATE_FOOTER_CONTEXT = {
    **CLIMATE_FOOTER_LABEL,
    "최근 5개년 평균": re.compile(
        r"5\s*개년|최근\s*5\s*년"
        r"|(?:19|20)\d{2}\s*년?\s*[~–—-]\s*(?:19|20)\d{2}\s*년"
    ),
}
# 문장이 값을 적는 대신 없음·미산정을 선언하면 자료 있는 것으로 세지 않는다.
_ABSENT_MARKERS = tuple(
    _norm_cell(x)
    for x in (
        "미산정", "산정하지 않", "산정 불가", "알 수 없", "확인할 수 없",
        "확인 불가", "자료 없음", "자료가 없", "자료 부족", "미확보",
        "확인 필요", "구하지 못", "조사하지 않", "측정하지 않", "없음",
        "없다", "없습니다", "해당 없음", "제외",
    )
)


def _footer_context_filled(lines, pattern):
    for line in lines:
        if not pattern.search(line):
            continue
        nline = _norm_cell(line)
        if any(m in nline for m in _ABSENT_MARKERS):
            continue
        # 값·날짜·좌표가 함께 적힌 문장만 자료 기록으로 본다.
        if not re.search(r"[\d:：°]", line):
            continue
        return True
    return False


def _disaster_tier(cell):
    """빈도 열 분류: 가장 자주=0, 가끔=1, 자주=2. 괄호 예시 목록("등")이
    든 라벨 셀은 빈도 열로 세지 않는다."""
    if "(" in cell and "등" in cell:
        return None
    n = _norm_cell(cell)
    if "가장" in n and "자주" in n and "발생" in n:
        return 0
    if "가끔" in n and "발생" in n:
        return 1
    if "자주" in n and "발생" in n:
        return 2
    return None


def _disaster_frequency_status(rows):
    """"none": 빈도 3열 구조 없음, "empty": 구조만 있고 유효 자료 행 없음,
    "ok": 헤더 아래 빈도 열에 채워진 셀이 있는 자료 행 존재."""
    for r, row in enumerate(rows):
        tiers = {}
        for c, cell in enumerate(row):
            t = _disaster_tier(cell)
            if t is not None:
                tiers[t] = c
        if len(tiers) != 3:
            continue
        cols = frozenset(tiers.values())
        ok = any(
            _filled_cell(rows[r2][c])
            for r2 in range(r + 1, len(rows))
            for c in cols
            if c < len(rows[r2])
        )
        return "ok" if ok else "empty"
    return "none"


# 행정구역 단계: 상위→하위 나열(도 > 시·군·구 > 읍·면 > 동·리·가)은
# 하나의 지역 표시이지 개인 공저자 나열이 아니다.
_GEO_LEVELS = {
    "도": 1, "시": 2, "군": 2, "구": 3, "읍": 3,
    "면": 3, "동": 4, "리": 5, "가": 5,
}
# 시·도 약칭(전북, 경남, 서울 등)은 접미 없이도 최상위 행정구역이다.
_GEO_NAMES = frozenset(
    "강원 경기 경남 경북 전남 전북 충남 충북 제주 세종 "
    "서울 부산 대구 인천 광주 대전 울산".split()
)
# 기관명 접미. 이 접미로 끝나는 토큰은 개인 성명으로 보지 않는다.
_ORG_TAILS = (
    "청", "부", "처", "위원회", "협회", "학회", "조합", "연맹", "총회",
    "중앙회", "연구소", "연구원", "개발원", "진흥원", "과학원", "기술원",
    "시험원", "관리원", "정보원", "대학교", "대학", "학교", "센터",
    "본부", "지부", "지국", "사업소", "사업단", "공사", "공단", "농협",
    "축협", "수협", "출판사", "신문사", "방송국", "도서관", "박물관",
    "미술관", "병원", "보건소", "사무소", "법인", "작목반", "영농조합",
    "마을",
)


def _geo_level(token):
    if token in _GEO_NAMES:
        return 1
    return _GEO_LEVELS.get(token[-1:])


def _is_org(token):
    return any(token.endswith(tail) for tail in _ORG_TAILS)


def _geo_descending(a, b):
    la, lb = _geo_level(a), _geo_level(b)
    return la is not None and lb is not None and la < lb


def _swot_placed(body_nodes):
    """Ⅲ-2 아래 마 단절 제목에 SWOT(또는 강점·약점·기회·위협 전부)가
    있으면 참. 다른 장·절의 제목과 본문의 단순 언급은 인정하지 않는다."""
    chapter = section = None
    roman = {"I": "Ⅰ", "II": "Ⅱ", "III": "Ⅲ", "IV": "Ⅳ", "V": "Ⅴ", "VI": "Ⅵ"}
    for n in body_nodes:
        if n.get("kind") != "heading":
            continue
        t = n["text"].strip()
        m = re.match(r"^([ⅠⅡⅢⅣⅤⅥ])\s*[\.．]", t) or re.match(
            r"^(III|II|IV|VI|I|V)\s*[\.．]", t
        )
        if m:
            chapter = roman.get(m[1], m[1])
            section = None
            continue
        m = re.match(r"^(\d+)\s*[\.．]", t)
        if m:
            section = int(m[1])
            continue
        if chapter != "Ⅲ" or section != 2:
            continue
        if re.match(r"^마\s*[\.．\)]|^\(마\)", t) and (
            "SWOT" in t
            or all(k in t for k in ("강점", "약점", "기회", "위협"))
        ):
            return True
    return False


def parse(text):
    lines, nodes, i = draft(text).splitlines(), [], 0
    previous_prose = False
    while i < len(lines):
        s = lines[i].strip()
        i += 1
        if not s:
            previous_prose = False
            continue
        if s.startswith("|"):
            rows = []
            while True:
                row = [x.strip() for x in s.strip("|").split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", x) for x in row):
                    rows.append(row)
                if i >= len(lines) or not lines[i].strip().startswith("|"):
                    break
                s = lines[i].strip()
                i += 1
            nodes.append({"kind": "table", "rows": rows})
        elif IMAGE.fullmatch(s):
            m = IMAGE.fullmatch(s)
            nodes.append({"kind": "image", "alt": m[1], "path": m[2]})
        elif CAPTION.fullmatch(s):
            m = CAPTION.fullmatch(s)
            nodes.append(
                {"kind": "caption", "label": m[1], "number": int(m[2]), "text": s}
            )
        else:
            level = None
            patterns = [
                r"[ⅠⅡⅢⅣⅤⅥIVX]+\. ",
                r"\d+\. ",
                r"[가-힣]\. ",
                r"\d+\) ",
                r"[가-힣]\) ",
                r"\(\d+\) ",
                r"\([가-힣]\) ",
                r"[①-⑳]",
                r"[㉮-㉾]",
            ]
            for j, pat in enumerate(patterns, 1):
                if re.match(pat, s):
                    level = j
                    break
            md = re.match(r"^(#{1,6})\s+(.+)", s)
            if md:
                level, s = len(md[1]), md[2]
            list_item = False
            if re.match(r"^[-+*]\s+", s):
                list_item = True
                s = re.sub(r"^[-+*]\s+", "", s)
            if (
                s.startswith(("```", "<table", "<script", "> "))
                or re.search(r"\[[^\]]+\]\([^)]+\)", s)
                or re.search(
                    r"`|~~|__|<\/?[A-Za-z][^>]*>|^#{7,}\s|(?<!\w)_[^_]+_", s
                )
            ):
                raise ValueError("미지원 Markdown 요소: " + s[:80])
            tail = None
            if level and not list_item:
                # "가. 소제목: 본문 문장"처럼 한 줄에 소제목과 내용이 붙은 경우
                # 소제목만 제목으로 두고 본문은 별도 단락으로 분리한다.
                # "라. 모델농장분석 : 부제"처럼 콜론 앞에 공백이 있는
                # 부제 표기는 그대로 유지한다.
                m = re.search(r"\S:\s+(\S.*)$", s)
                if m:
                    head = s[: m.start() + 1].rstrip()
                    rest = m.group(1).strip()
                    if head and rest:
                        s, tail = head, rest
            node = {"kind": "heading" if (level and not list_item) else "paragraph", "text": s}
            if level:
                node["level"] = level
            if list_item:
                node["list_item"] = True
            prose = node["kind"] == "paragraph" and not list_item
            if prose and previous_prose:
                node["soft_continue"] = True
            nodes.append(node)
            previous_prose = prose
            if tail:
                nodes.append({"kind": "paragraph", "text": tail})
                previous_prose = True
            # A Markdown hard break terminates this line's paragraph boundary.
            if lines[i - 1].endswith("  "):
                previous_prose = False
            continue
        previous_prose = False
    return nodes


def spans(rows):
    if not rows or not rows[0] or any(len(r) != len(rows[0]) for r in rows):
        raise ValueError("표 열 수 불일치")
    anchors = {}
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            if v == "^":
                if r == 0:
                    raise ValueError("첫 행 세로 병합")
                a = anchors[r - 1, c]
            elif v == "<":
                if c == 0:
                    raise ValueError("첫 열 가로 병합")
                a = anchors[r, c - 1]
            else:
                a = (r, c)
            anchors[r, c] = a
    groups = {}
    for pos, a in anchors.items():
        groups.setdefault(a, []).append(pos)
    result = []
    for a, cells in groups.items():
        r1, c1 = max(r for r, c in cells), max(c for r, c in cells)
        if set(cells) != {
            (r, c) for r in range(a[0], r1 + 1) for c in range(a[1], c1 + 1)
        }:
            raise ValueError("비직사각형 병합")
        if len(cells) > 1:
            result.append((a[0], a[1], r1, c1))
    return result


def section_body(nodes, i):
    level = nodes[i].get("level") or 1
    parts = [nodes[i]["text"]]
    for extra in nodes[i + 1 :]:
        if extra["kind"] == "heading" and (extra.get("level") or 99) <= level:
            break
        if extra["kind"] in {"paragraph", "heading", "caption"}:
            parts.append(extra["text"])
        elif extra["kind"] == "table":
            parts.append("\n".join(" ".join(r) for r in extra["rows"]))
    return "\n".join(parts)


def require_tokens(issues, cid, body, tokens, reason):
    missing = [x for x in tokens if x not in body]
    if missing:
        issues.append((cid, reason + ": " + ", ".join(missing)))


def check(text, base):
    nodes = parse(text)
    issues = []
    full = set()
    for n in nodes:
        if n["kind"] in {"paragraph", "heading"}:
            for m in SCI.finditer(n["text"]):
                g, species = m.groups()
                if g.endswith("."):
                    if not any(x.startswith(g[0]) and y == species for x, y in full):
                        issues.append(
                            (
                                "scientific_name",
                                "학명 전체표기가 본문 앞에 없음: " + m[0],
                            )
                        )
                else:
                    full.add((g, species))
            if re.search(
                r"\d(?:kg|㎏|mg|cm|mm|㎡|ha|mL|kg|g|m|L)(?=$|[^A-Za-z])", n["text"]
            ):
                issues.append(("unit_spacing", "수치·단위 붙여쓰기: " + n["text"]))
    for label in ("표", "그림"):
        caps = [n for n in nodes if n["kind"] == "caption" and n["label"] == label]
        if [n["number"] for n in caps] != list(range(1, len(caps) + 1)):
            issues.append(("global_numbering", label + " 전역 번호 중복/누락"))
        prose = "\n".join(n["text"] for n in nodes if n["kind"] == "paragraph")
        for n in caps:
            if not re.search(
                r"(?<![가-힣A-Za-z0-9])"
                + label
                + r"\s*"
                + str(n["number"])
                + r"(?!\d)",
                prose,
            ):
                issues.append(("object_reference", n["text"] + " 본문 참조 없음"))
        numbers = {n["number"] for n in caps}
        for m in re.finditer(r"(?<![가-힣A-Za-z0-9])" + label + r"\s*(\d+)", prose):
            if int(m[1]) not in numbers:
                issues.append(("missing_caption", m[0] + " 참조의 캡션 없음"))
    for i, n in enumerate(nodes):
        if n["kind"] == "caption":
            j = i + 1 if n["label"] == "표" else i - 1
            kind = "table" if n["label"] == "표" else "image"
            if j < 0 or j >= len(nodes) or nodes[j]["kind"] != kind:
                issues.append(("missing_object", n["text"] + " 실제 객체 없음"))
        if n["kind"] == "image":
            if (
                i + 1 >= len(nodes)
                or nodes[i + 1]["kind"] != "caption"
                or nodes[i + 1]["label"] != "그림"
            ):
                issues.append(("missing_caption", "그림 객체의 캡션 없음"))
            p = Path(n["path"])
            if (
                p.is_absolute()
                or "://" in str(p)
                or not (Path(base) / p).is_file()
                or not (Path(base) / p).resolve().is_relative_to(Path(base).resolve())
            ):
                issues.append(("missing_image", n["path"]))
        if n["kind"] == "table":
            if (
                i == 0
                or nodes[i - 1]["kind"] != "caption"
                or nodes[i - 1]["label"] != "표"
            ):
                issues.append(("missing_caption", "표 객체의 캡션 없음"))
            try:
                spans(n["rows"])
            except ValueError as e:
                issues.append(("table_merge", str(e)))
            content = "\n".join(" ".join(r) for r in n["rows"])
            if re.search(r"평균\s*기온", content):
                # 각주 항목은 표 안쪽 라벨 행 또는 표 바로 아래 주·자료
                # 문맥에서만 확인한다. 다른 표나 본문 요약이 누락을
                # 덮지 않는다.
                footer_lines = []
                for extra in nodes[i + 1 : i + 4]:
                    if extra["kind"] in {"paragraph", "caption"}:
                        footer_lines.extend(extra["text"].splitlines())
                missing = [
                    x
                    for x in CLIMATE
                    if not _field_filled(n["rows"], CLIMATE_PATTERNS[x])
                ]
                missing += [
                    x
                    for x in CLIMATE_FOOTER
                    if not _field_filled(n["rows"], CLIMATE_FOOTER_LABEL[x])
                    and not _footer_context_filled(
                        footer_lines, CLIMATE_FOOTER_CONTEXT[x]
                    )
                ]
                if missing:
                    issues.append(
                        (
                            "climate_fields",
                            "학교 기상 필수항목 누락: " + ", ".join(missing),
                        )
                    )
            if any(x in content for x in DISASTER_FREQ + DISASTER_TYPES):
                status = _disaster_frequency_status(n["rows"])
                if status == "none":
                    issues.append(
                        (
                            "disaster_fields",
                            "학교 재해 빈도 구조 누락: " + ", ".join(DISASTER_FREQ),
                        )
                    )
                elif status == "empty":
                    issues.append(
                        (
                            "disaster_fields",
                            "학교 재해 빈도표 유효 자료 행 없음",
                        )
                    )
            if any(x in content for x in FARM_MARKERS):
                missing = [
                    x
                    for x in (
                        "농장명",
                        "경영주",
                        "농장위치",
                        "가족사항",
                        "주요작목",
                    )
                    if x not in content
                ]
                if "경영주" not in content and "농장주" in content:
                    missing = [x for x in missing if x != "경영주"]
                if missing:
                    issues.append(
                        (
                            "farm_overview_fields",
                            "학교 농장개요 필수항목 누락: " + ", ".join(missing),
                        )
                    )
    toc_range = school_toc_range(nodes)
    toc_start, body_start = toc_range if toc_range else (-1, -1)
    for i, n in enumerate(nodes):
        if n["kind"] != "heading":
            continue
        if toc_start <= i < body_start:
            continue
        body = "\n".join(section_body(nodes, i).splitlines()[1:])
        if re.search(r"[ⅤV]\s*[\.．]", n["text"]) and "맺음말" in n["text"]:
            require_tokens(
                issues,
                "closing_elements",
                body,
                ("결론", "전략", "보완"),
                "Ⅴ 맺음말 어휘 미관측(충족 판정은 독립 내용검토)",
            )
        if re.search(r"시장환경", n["text"]):
            require_tokens(
                issues,
                "market_sections",
                body,
                ("수급", "소비", "가격", "유통"),
                "Ⅱ-2 시장환경 소절 누락",
            )
        if re.search(r"[ⅠI]\s*[\.．]", n["text"]) and "머리말" in n["text"]:
            require_tokens(
                issues,
                "intro_topics",
                body,
                ("형태", "방법", "조건", "전망", "애로", "비전"),
                "Ⅰ 머리말 어휘 미관측(충족 판정은 독립 내용검토)",
            )
        if "지리" in n["text"] and ("사회" in n["text"] or "경제" in n["text"]):
            require_tokens(
                issues,
                "geo_socio",
                body,
                ("지리", "생산", "유통"),
                "Ⅱ-1-다 지리·사회·경제 소절 누락",
            )
        if (
            (re.search(r"^\s*5\s*[\.．]", n["text"]) or n.get("level") in (1, 2))
            and "가공" in n["text"]
            and not re.match(r"^[가-힣]\s*[\.．\)]", n["text"].strip())
        ):
            require_tokens(
                issues,
                "process_plan",
                body,
                ("정의", "전망", "시장", "생산"),
                "Ⅲ-5 가공·판매 어휘 미관측(충족 판정은 독립 내용검토)",
            )
        if "관련" in n["text"] and "논문" in n["text"]:
            entries = {
                line.split("계획 연결:", 1)[0].strip()
                for line in body.splitlines()
                if re.search(r"\b(?:19|20)\d{2}\b", line)
            }
            if len(entries) < 3:
                issues.append(
                    ("related_papers", "관련 논문 3편 미만(연도 포함 개별 서지 기준)")
                )
        if re.search(r"가족구성|성장목표", n["text"]):
            if not re.search(r"천원", body) or not re.search(r"㎡", body):
                issues.append(
                    (
                        "plan_year_units",
                        "가족구성·성장목표 매출/순이익은 천원, 면적은 ㎡",
                    )
                )
        if re.search(r"[ⅥVI]+\s*[\.．]", n["text"]) and "참고문헌" in n["text"]:
            if not re.search(r"\d{4}", body):
                issues.append(("bibliography_year", "참고문헌 출판연도 없음"))
            for line in body.splitlines():
                m = re.search(r"\b(?:19|20)\d{2}\b", line)
                if not m:
                    continue
                author_part = line[: m.start()].strip().rstrip(".")
                if re.search(r"[가-힣]", author_part):
                    # 완전한 2–4음절 이름 토큰만 짝짓는다. 경계가 없으면
                    # "농촌진흥청 국립원예특작과학원" 같은 긴 기관명이 잘려
                    # 두 명의 개인으로 오인된다. 기관명 접미 토큰과
                    # 상위→하위 행정구역 나열(예: 전북 고창군 신림면)은
                    # 개인 공저가 아니므로 제외한다.
                    korean_name = r"(?<![가-힣])[가-힣]{2,4}(?![가-힣])"
                    names = list(re.finditer(korean_name, author_part))
                    has_multi = any(
                        re.fullmatch(
                            r"\s*(?:,|&|and\b)?\s*",
                            author_part[a.end() : b.start()],
                        )
                        and not (_is_org(a[0]) or _is_org(b[0]))
                        and not _geo_descending(a[0], b[0])
                        for a, b in zip(names, names[1:])
                    )
                    if has_multi and "ㆍ" not in author_part:
                        issues.append(
                            ("bibliography_join", "국문 저자 연결 기호 ㆍ 없음")
                        )
                        break
        if re.search(r"SWOT", n["text"]) and re.match(r"4\s*[\.．]", n["text"]):
            issues.append(("school_swot", "SWOT는 Ⅲ-2-마이지 Ⅱ-4가 아님"))
        if re.search(r"[ⅥVI]+\s*[\.．]", n["text"]) and "참고문헌" in n["text"]:
            if re.search(r"관련\s*논문", body):
                issues.append(("related_papers_place", "관련 논문은 Ⅲ-6이지 Ⅵ이 아님"))
    school_structure(text, issues, nodes=nodes)
    return issues


FRONT = ("겉표지", "인준서", "표제면", "제출서", "목차")
CHAPTERS = (
    (r"[ⅠI]\s*[\.．].*머리말", "머리말"),
    (r"[ⅡII]+\s*[\.．].*외부환경", "외부환경"),
    (r"[ⅢIII]+\s*[\.．].*영농계획", "영농계획"),
    (r"[ⅣIV]+\s*[\.．].*재무", "재무"),
    (r"[ⅤV]\s*[\.．].*맺음말", "맺음말"),
    (r"[ⅥVI]+\s*[\.．].*참고문헌", "참고문헌"),
)


def school_frontmatter_plan(nodes):
    """Locate school logical front sections in either supported order.

    Legacy drafts emitted approval before title/submission.  The official form
    order is title/submission before approval.  Both are accepted so generic
    Markdown exports remain compatible; callers can inspect ``order`` to choose
    physical page composition.
    """
    front_indices = {}
    for i, n in enumerate(nodes):
        t = n.get("text", "").strip()
        if t in FRONT and t not in front_indices:
            front_indices[t] = i
    if len(front_indices) != len(FRONT):
        return None
    orders = (
        ("겉표지", "인준서", "표제면", "제출서", "목차"),
        ("겉표지", "표제면", "제출서", "인준서", "목차"),
    )
    order = next((candidate for candidate in orders if all(
        front_indices[candidate[i]] < front_indices[candidate[i + 1]]
        for i in range(len(candidate) - 1)
    )), None)
    if order:
        i_toc = front_indices["목차"]
        # 본문은 목차 항목 뒤부터 시작한다. 목차의 마지막 항목(감사의 글)은 뒤에
        # 본문 절이 이어지고, 본문 끝의 감사의 글은 뒤가 비어 있어 둘을 구분한다.
        i_body = None
        for i in range(i_toc + 1, len(nodes)):
            if nodes[i].get("text", "").strip() == "감사의 글" and any(
                re.match(r"^[ⅠⅡⅢⅣⅤⅥ]\s*[\.．]", n.get("text", ""))
                for n in nodes[i + 1 :]
            ):
                i_body = i + 1
                break
        if i_body is None:
            for i in range(len(nodes) - 1, i_toc, -1):
                if re.search(r"^[ⅠI]\s*[\.．].*머리말", nodes[i].get("text", "")):
                    i_body = i
                    break
        if i_body is None:
            i_body = i_toc + 1
        return {
            "indices": front_indices,
            "order": order,
            "toc": i_toc,
            "body": i_body,
            "official_order": order == orders[1],
        }
    return None


def school_toc_range(nodes):
    plan = school_frontmatter_plan(nodes)
    if plan:
        return plan["toc"], plan["body"]
    return None


def school_structure(text, issues, nodes=None):
    if nodes is None:
        nodes = parse(text)
    toc_range = school_toc_range(nodes)
    if toc_range:
        body_nodes = nodes[toc_range[1] :]
        body_text = "\n".join(n.get("text", "") for n in body_nodes)
    else:
        body_nodes = nodes
        body_text = text

    n_chapters = sum(1 for pat, _ in CHAPTERS if re.search(pat, body_text))
    has_front = all(x in text for x in FRONT)
    if not has_front and n_chapters < 3:
        return
    missing_front = [x for x in FRONT if x not in text]
    if missing_front:
        issues.append(("school_front", "머리지면 누락: " + ", ".join(missing_front)))
    missing_ch = [name for pat, name in CHAPTERS if not re.search(pat, body_text)]
    if missing_ch:
        issues.append(("school_chapters", "Ⅰ–Ⅵ 필수장 누락: " + ", ".join(missing_ch)))
    if "감사의 글" not in body_text:
        issues.append(("school_thanks", "감사의 글 없음"))
    elif body_text.rfind("감사의 글") < body_text.rfind("참고문헌"):
        issues.append(("school_thanks", "감사의 글은 참고문헌 뒤에"))
    if "SWOT" in body_text and not _swot_placed(body_nodes):
        issues.append(("school_swot", "SWOT는 Ⅲ-2-마"))
    writing = re.search(r"작성연도\s*(\d{4})", text)
    if writing:
        start = int(writing[1]) + 1
        if str(start) not in text or str(start + 4) not in text:
            issues.append(
                ("plan_year_calc", "창업연도=작성연도+1, 목표연도=창업연도+4 불일치")
            )
    return issues
