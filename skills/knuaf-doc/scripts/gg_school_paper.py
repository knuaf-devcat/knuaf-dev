#!/usr/bin/env python3
"""School I–VI markdown generator.

Spec schema and contract:
- Frontmatter & Metadata:
  - writing_year: int (required, e.g. 2026)
  - title: str (optional)
  - author: str (optional)
  - major: str (optional)
  - advisor: str (optional)
  - submitted: str (optional)
  - committee_chair: str (optional)
  - committee_members: list[str] (optional, default 3 members)
  - committee: dict(chair=str, members=list[str]) (optional)

- Chapter I (머리말):
  - business_form: str (창업 형태, optional)
  - farming_type: str (영농 형태, optional)
  - startup_method: str (창업 방법, optional)
  - regional_conditions: str (지리적·환경적 조건, optional)
  - crop_prospect: str (작목 전망, optional)
  - challenges: str (애로 및 제한 사항, optional)
  - vision / farm_vision: str (농장 발전방향과 비전, optional)

- Chapter II (외부환경분석):
  - farm_name, manager, location, family, crop: str (농장 종합 개요)
  - climate: dict[str, dict[str, str]] (기상환경 데이터)
  - climate_footer: dict(place=str, period=str, first_frost=str, last_frost=str)
  - terrain / topography: str (농장의 지형, optional)
  - field_preparation / land_consolidation: str (포장의 경지정리 상태, optional; 학교 규칙 5) 항목)
  - soil / soil_condition: str (토양조건, optional)
  - water / water_condition / irrigation: str (수리조건, optional)
  - disaster: dict[str, dict[str, str]] (재해 빈도 데이터)
  - shipping_markets / market_distances: list (출하시장 거리 데이터, optional)
  - production_status: str (주요 농산물 생산 현황, optional)
  - distribution_status: str (영농조직 및 유통과정, optional)
  - supply_demand: str (수급 동향 분석, optional)
  - consumption_trends: str (소비동향 분석, optional)
  - price_distribution: str (가격형성과 유통경로 분석, optional)

- Chapter III (영농계획수립):
  - vision / farm_vision: str (농장 비전, optional)
  - crop / start_crop: str (창업연도 작목)
  - target_crop / goal_crop: str (목표연도 작목, optional)
  - area_m2 / start_area_m2: str|int (창업연도 생산규모)
  - target_area_m2 / goal_area_m2: str|int (목표연도 생산규모, optional)
  - sales_thousand / start_sales_thousand: str|int (창업연도 연간매출액)
  - target_sales_thousand / goal_sales_thousand: str|int (목표연도 연간매출액, optional)
  - profit_thousand / start_profit_thousand: str|int (창업연도 연간순이익)
  - target_profit_thousand / goal_profit_thousand: str|int (목표연도 연간순이익, optional)
  - sales_profit_goals: str (매출액 및 순이익 목표 설명, optional)
  - sales_basis: str (매출액 산출근거, optional)
  - benchmark_farm / model_farm: str (모델농장/벤치마킹 분석, optional)
  - swot: dict(strength/강점=str, weakness/약점=str, opportunity/기회=str, threat/위협=str) (optional)
  - detailed_farming_plan: str (세부영농계획, optional)
  - cultivation_technology: dict or str (optional)
    - general_info / 일반사항: str (optional)
    - soil_management / 본포준비: str (optional)
    - cultivation_methods / 재배기술: str (optional)
  - processing_plan: dict or str (optional)
    - processing_def / 정의: str (optional)
    - processing_prospect / 전망: str (optional)
    - processing_market / 시장: str (optional)
    - processing_production / 생산: str (optional)
  - related_papers: list[dict(author=str, year=str, title=str, link=str, apply=str)] (optional)

- Chapter IV (재무계획):
  - asset_survey: str (자산조사 설명, optional)
  - cost_plan: str (생산원가계획 설명, optional)
  - income_plan: str (손익계획 설명, optional)
  - balance_sheet_plan: str (추정대차대조표 설명, optional)
  - cash_flow_plan: str (현금흐름계획 설명, optional)
  - income_analysis: str (추정소득분석 설명, optional)

- Chapter V (맺음말 및 발전방향):
  - conclusion: str (결론, optional)
  - strategy: str (전략, optional)
  - follow_up: str (보완, optional)

- Chapter VI (참고문헌 & 감사의 글):
  - bibliography: list[dict(author=str, year=str, title=str)] (optional)
  - acknowledgments: str (감사의 글, optional)
"""

import argparse
import json
from pathlib import Path

from gg_core import local
from gg_frontmatter import frontmatter_lines, normalize_school_profile

PENDING = "[확인 필요]"
SEASONS = (
    "겨울(12·1·2월)",
    "봄(3·4·5월)",
    "여름(6·7·8월)",
    "가을(9·10·11월)",
    "연평균",
)
SHORT_SEASONS = ("겨울", "봄", "여름", "가을", "연평균")
CLIMATE = (
    "평균기온(℃)",
    "최고기온(℃)",
    "최저기온(℃)",
    "강우량(mm)",
    "평균적설량(cm)",
    "최고적설량(cm)",
    "주된풍향",
    "평균풍속(m/s)",
    "최대풍속(m/s)",
)
DISASTER = ("한발", "홍수", "태풍", "공장폐수", "공해가스", "야생동물")


def need(spec, *keys, default=PENDING):
    if not isinstance(spec, dict):
        if isinstance(spec, str) and spec.strip():
            return spec.strip()
        return default
    for k in keys:
        if k in spec and spec[k] is not None:
            v = str(spec[k]).strip()
            if v:
                return v
    return default


def years(spec):
    writing = spec.get("writing_year")
    if type(writing) is not int or writing < 1900 or writing > 2100:
        raise ValueError("작성연도 정수 필요")
    start = writing + 1
    return writing, start, start + 4, [start + i for i in range(5)]


def table(headers, rows):
    lines = [
        "|" + "|".join(headers) + "|",
        "|" + "|".join("---" for _ in headers) + "|",
    ]
    for row in rows:
        lines.append("|" + "|".join(str(x) for x in row) + "|")
    return "\n".join(lines)


def climate_table(spec):
    """Render the school 14-column climate form (Dec–Nov + annual average).

    Monthly values must be supplied explicitly under ``climate_monthly``.  The
    legacy seasonal ``climate`` mapping is retained for annual labels only;
    seasonal numbers are never copied into monthly cells.
    """
    monthly_spec = spec.get("climate_monthly") or {}
    seasonal_spec = spec.get("climate") or {}
    months = ("12월", "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월")
    rows = []
    for name in CLIMATE:
        monthly = monthly_spec.get(name) or {}
        seasonal = seasonal_spec.get(name) or {}
        cells = [name]
        for month in months:
            cells.append(need({"v": monthly.get(month)}, "v"))
        annual = monthly.get("연평균")
        if annual is None:
            annual = seasonal.get("연평균")
        cells.append(need({"v": annual}, "v"))
        rows.append(cells)
    footer = spec.get("climate_footer") or {}
    merge = ["<"] * 11
    extra = [
        ["관측장소", need(footer, "place")] + merge + [need(footer, "place_annual", default=PENDING)],
        ["최근 5개년 평균", need(footer, "period")] + merge + [need(footer, "period_annual", default=PENDING)],
        ["초상일", need(footer, "first_frost")] + merge + [need(footer, "first_frost_annual", default=PENDING)],
        ["만상일", need(footer, "last_frost")] + merge + [need(footer, "last_frost_annual", default=PENDING)],
    ]
    header = ["항목", "겨울", "<", "<", "봄", "<", "<", "여름", "<", "<", "가을", "<", "<", "연평균"]
    month_header = ["월·기간"] + list(months) + ["연평균"]
    return table(header, [month_header] + rows + extra)

def disaster_table(spec):
    data = spec.get("disaster") or {}
    rows = []
    for name in DISASTER:
        row = data.get(name) or {}
        rows.append(
            [
                name,
                need(row, "가장 자주 발생"),
                need(row, "자주 발생"),
                need(row, "가끔 발생"),
            ]
        )
    return table(["구분", "가장 자주 발생", "자주 발생", "가끔 발생"], rows)


def shipping_market_table(spec):
    items = spec.get("shipping_markets") or spec.get("market_distances") or []
    rows = []
    if isinstance(items, list) and items:
        for item in items:
            if isinstance(item, (list, tuple)):
                row = [
                    str(x).strip() if x is not None and str(x).strip() else PENDING
                    for x in item
                ]
                while len(row) < 4:
                    row.append(PENDING)
                rows.append(row[:4])
            elif isinstance(item, dict):
                rows.append(
                    [
                        need(item, "market", "주요출하시장"),
                        need(item, "distance", "거리"),
                        need(item, "time", "duration", "소요시간"),
                        need(item, "note", "비고"),
                    ]
                )
    if not rows:
        rows = [[PENDING, PENDING, PENDING, PENDING]]
    return table(["주요출하시장", "거리", "소요시간", "비고"], rows)


def swot_table(spec):
    data = spec.get("swot") or {}
    if not isinstance(data, dict):
        data = {}
    return table(
        ["구분", "내용"],
        [
            ["강점", need(data, "strength", "강점", default=PENDING)],
            ["약점", need(data, "weakness", "약점", default=PENDING)],
            ["기회", need(data, "opportunity", "기회", default=PENDING)],
            ["위협", need(data, "threat", "위협", default=PENDING)],
        ],
    )


def papers(spec):
    items = spec.get("related_papers") or []
    if not isinstance(items, list) or not items:
        return "관련 논문(3편 이상 필요): " + PENDING + "\n"
    lines = []
    for item in items:
        if isinstance(item, dict):
            lines.append(
                "%s. %s. %s. 계획 연결: %s. 적용: %s."
                % (
                    need(item, "author", default=PENDING),
                    need(item, "year", default=PENDING),
                    need(item, "title", default=PENDING),
                    need(item, "link", default=PENDING),
                    need(item, "apply", default=PENDING),
                )
            )
        elif isinstance(item, str) and item.strip():
            lines.append(item.strip())
    if len(items) < 3:
        lines.append(
            "%s 관련 논문 %d편 입력됨 (최소 3편 이상 필요, %d편 부족)."
            % (PENDING, len(items), 3 - len(items))
        )
    return "\n".join(lines) + "\n"


def bibliography(spec):
    items = spec.get("bibliography") or spec.get("related_papers") or []
    if not isinstance(items, list) or not items:
        return PENDING + "\n"
    lines = []
    for item in items:
        if isinstance(item, dict):
            lines.append(
                "%s. %s. %s."
                % (
                    need(item, "author", default=PENDING),
                    need(item, "year", default=PENDING),
                    need(item, "title", default=PENDING),
                )
            )
        elif isinstance(item, str) and item.strip():
            lines.append(item.strip())
    return "\n".join(lines) + "\n"


def committee_lines(spec, name, submitted):
    chair = need(
        {
            "c": (spec.get("committee") or {}).get("chair")
            or spec.get("committee_chair")
        },
        "c",
        default=PENDING,
    )
    members_raw = (
        spec.get("committee_members")
        or (spec.get("committee") or {}).get("members")
        or []
    )
    if isinstance(members_raw, (list, tuple)):
        members = [str(m).strip() for m in members_raw if str(m).strip()]
    else:
        members = [str(members_raw).strip()] if str(members_raw).strip() else []
    while len(members) < 3:
        members.append(PENDING)
    lines = [
        "인준서",
        name + "의 농업전문학사 학위논문을 인준함",
        submitted,
        "위원장 " + chair + " (인)",
    ]
    for m in members:
        lines.append("위  원 " + m + " (인)")
    return lines


def growth_target_table(spec, start, goal, unit):
    start_crop = need(spec, "crop", "start_crop")
    goal_crop = need(spec, "target_crop", "goal_crop", default=start_crop)
    start_area = need(spec, "start_area_m2", "area_m2")
    goal_area = need(spec, "target_area_m2", "goal_area_m2", default=PENDING)
    start_sales = need(spec, "start_sales_thousand", "sales_thousand")
    goal_sales = need(
        spec, "target_sales_thousand", "goal_sales_thousand", default=PENDING
    )
    start_profit = need(spec, "start_profit_thousand", "profit_thousand")
    goal_profit = need(
        spec, "target_profit_thousand", "goal_profit_thousand", default=PENDING
    )
    # School-required 가정/농장 rows (single-value; merged across both year columns with "<").
    role = need(spec, "family_role", default=PENDING)
    comp = need(spec, "family_composition", "family", default=PENDING)
    lifestyle = need(spec, "family_lifestyle", default=PENDING)
    method = need(spec, "production_method", "farming_type", default=PENDING)
    facilities = need(spec, "facilities", "facility_spec", default=PENDING)
    return table(
        ["구분", str(start) + "년", str(goal) + "년"],
        [
            ["본인 연령/역할", role, "<"],
            ["가족의 구성", comp, "<"],
            ["생활목표", lifestyle, "<"],
            ["주력작목", start_crop, goal_crop],
            ["생산방식/경영유형", method, "<"],
            ["생산규모(㎡)", start_area, goal_area],
            ["연간매출액(" + unit + ")", start_sales, goal_sales],
            ["연간순이익(" + unit + ")", start_profit, goal_profit],
            ["주요 생산시설", facilities, "<"],
        ],
    )


def _legacy_paper(spec):
    writing, start, goal, _years = years(spec)
    title = need(spec, "title")
    name = need(spec, "author")
    major = need(spec, "major")
    advisor = need(spec, "advisor")
    submitted = need(spec, "submitted")
    crop = need(spec, "crop")
    start_area = need(spec, "start_area_m2", "area_m2")
    start_sales = need(spec, "start_sales_thousand", "sales_thousand")
    start_profit = need(spec, "start_profit_thousand", "profit_thousand")
    unit = "천원"

    cult_tech = spec.get("cultivation_technology") or {}
    proc_plan = spec.get("processing_plan") or {}

    sections = [
        "겉표지",
        "농업전문학사 학위논문",
        "영농창업계획",
        title,
        submitted,
        "한국농수산대학교",
        major,
        name,
        "",
    ]
    sections.extend(committee_lines(spec, name, submitted))
    sections.extend(
        [
            "",
            "표제면",
            advisor + " 교수 지도",
            "농업전문학사 학위논문",
            "영농창업계획",
            title,
            "이 논문을 농업전문학사 학위논문으로 제출함",
            submitted,
            "한국농수산대학교",
            major,
            name,
            "",
            "제출서",
            "이 영농창업계획을 학교 양식에 따라 제출한다.",
            "",
            "목차",
            "요약",
            "I. 사업의 개요",
            "II. 투자분석",
            "III. 수익성분석",
            "IV. 자금운영계획",
            "V. 중장기 발전방향 및 성장목표",
            "표 목차",
            "그림 목차",
            "Ⅰ. 머리말",
            "Ⅱ. 외부환경분석",
            "Ⅲ. 영농계획수립",
            "Ⅳ. 재무계획",
            "Ⅴ. 맺음말 및 발전방향",
            "Ⅵ. 참고문헌",
            "감사의 글",
            "",
            "Ⅰ. 머리말",
            "창업 형태: %s" % need(spec, "business_form", default=PENDING),
            "영농규모 및 영농형태: 생산규모 %s ㎡, 형태 %s"
            % (start_area, need(spec, "farming_type", default=PENDING)),
            "창업 방법: %s" % need(spec, "startup_method", default=PENDING),
            "대상지역의 지리적·환경적 조건: %s"
            % need(spec, "regional_conditions", default=PENDING),
            "작목의 전망: %s" % need(spec, "crop_prospect", default=PENDING),
            "애로 및 제한 사항: %s" % need(spec, "challenges", default=PENDING),
            "농장의 발전방향과 비전: %s (5개년 목표: %s~%s년, 작성연도 %s년)"
            % (
                need(spec, "vision", "farm_vision", default=PENDING),
                start,
                goal,
                writing,
            ),
            "",
            "Ⅱ. 외부환경분석",
            "1. 농업환경분석",
            "가. 농장 개요",
            "표 1은 농장 종합 개요다.",
            "표 1. 농장 종합 개요",
            table(
                ["항목", "내용"],
                [
                    ["농장명", need(spec, "farm_name")],
                    ["경영주", need(spec, "manager")],
                    ["농장위치", need(spec, "location")],
                    ["가족사항", need(spec, "family")],
                    ["주요작목", crop],
                ],
            ),
            "나. 지역적 조건",
            "1) 기상환경",
            "표 2는 학교 양식의 12개월(12월~11월)과 연평균을 담은 기상환경이다. 겨울(12·1·2월), 봄(3·4·5월), 여름(6·7·8월), 가을(9·10·11월)은 머리에서 병합하고, 월별 원자료가 없으면 각 월을 확인 필요로 남긴다.",
            "표 2. 기상환경",
            climate_table(spec),
            "2) 농장의 지형: %s" % need(spec, "terrain", "topography", default=PENDING),
            "3) 토양조건: %s" % need(spec, "soil", "soil_condition", default=PENDING),
            "4) 수리조건: %s"
            % need(spec, "water", "water_condition", "irrigation", default=PENDING),
            "5) 포장의 경지정리 상태: %s"
            % need(spec, "field_preparation", "land_consolidation", default=PENDING),
            "6) 재해",
            "표 3은 재해 빈도이다.",
            "표 3. 재해",
            disaster_table(spec),
            "다. 지리, 사회, 경제적 조건",
            "1) 지리적 조건: 교통 및 도로망, 차량 진입, 주요 출하시장 거리를 분석한다.",
            "표 4는 출하시장 거리다.",
            "표 4. 출하시장 거리",
            shipping_market_table(spec),
            "2) 주요농산물 생산현황: %s"
            % need(spec, "production_status", default=PENDING),
            "3) 영농조직상태 및 주요 농산물 유통과정: %s"
            % need(spec, "distribution_status", default=PENDING),
            "2. 시장환경분석",
            "가. 수급 동향 분석: %s" % need(spec, "supply_demand", default=PENDING),
            "나. 소비동향 분석: %s" % need(spec, "consumption_trends", default=PENDING),
            "다. 가격형성과 유통경로 분석: %s"
            % need(spec, "price_distribution", default=PENDING),
            "",
            "Ⅲ. 영농계획수립",
            "1. 농장비전",
            need(spec, "vision", "farm_vision", default=PENDING),
            "2. 영농목표 및 전략",
            "가. 농장의 가족구성 및 성장목표",
            "표 5는 가족구성 및 성장목표다. 매출·순이익은 천원, 면적은 ㎡다.",
            "표 5. 가족구성 및 성장목표",
            growth_target_table(spec, start, goal, unit),
            "나. 매출액 및 순이익 목표",
            need(spec, "sales_profit_goals", default=PENDING),
            "다. 매출액 근거",
            need(spec, "sales_basis", default=PENDING),
            "라. 모델농장분석 : 벤치마킹(Benchmarking)",
            need(spec, "benchmark_farm", "model_farm", default=PENDING),
            "마. SWOT 분석",
            "표 6은 SWOT 분석이다.",
            "표 6. SWOT 분석",
            swot_table(spec),
            "3. 세부영농계획",
            need(spec, "detailed_farming_plan", default=PENDING),
            "4. 재배기술",
            "가. 일반 사항: %s"
            % need(
                cult_tech,
                "general_info",
                "일반사항",
                default="효능, 영양 성분, 이용 방법, 품종, 재배 환경 " + PENDING,
            ),
            "나. 본포준비와 토양관리: %s"
            % need(cult_tech, "soil_management", "본포준비", default=PENDING),
            "다. 재배 기술: %s"
            % need(
                cult_tech,
                "cultivation_methods",
                "재배기술",
                default="번식, 재배 방법, 관수, 잡초방제, 병해충방제, 친환경 방제, PLS 제도, 수확 및 저장법 "
                + PENDING,
            ),
            "5. 가공ㆍ판매계획",
            "가. 특용작물 (농산물) 가공의 정의: %s"
            % need(proc_plan, "processing_def", "정의", default=PENDING),
            "나. 농산물 가공 사업의 전망: %s"
            % need(proc_plan, "processing_prospect", "전망", default=PENDING),
            "다. 해당 작물 가공품의 시장 현황: %s"
            % need(proc_plan, "processing_market", "시장", default=PENDING),
            "라. 가공품 생산 계획 (가공 아이디어 도출): %s"
            % need(proc_plan, "processing_production", "생산", default=PENDING),
            "6. 관련 논문",
            papers(spec),
            "Ⅳ. 재무계획",
            "1. 자산조사",
            need(
                spec,
                "asset_survey",
                default="자산조사 결과는 동반 재무계획과 단위 "
                + unit
                + "로 일치시킨다.",
            ),
            "2. 생산원가계획",
            need(spec, "cost_plan", default=PENDING),
            "3. 손익계획",
            need(
                spec,
                "income_plan",
                default="연도별 소득 목표는 추정소득과 일치한다. %s %s년 매출액은 %s%s이다. %s %s년 당기순이익은 %s%s이다."
                % (
                    need(spec, "farm_name"),
                    start,
                    start_sales,
                    unit,
                    need(spec, "farm_name"),
                    start,
                    start_profit,
                    unit,
                ),
            ),
            "4. 추정대차대조표",
            need(spec, "balance_sheet_plan", default=PENDING),
            "5. 현금흐름계획",
            need(spec, "cash_flow_plan", default=PENDING),
            "6. 추정소득분석",
            need(spec, "income_analysis", default=PENDING),
            "",
            "Ⅴ. 맺음말 및 발전방향",
            "결론: %s"
            % need(
                spec,
                "conclusion",
                default="5개년(%s~%s) 영농창업계획의 타당성 및 목표 [%s]"
                % (start, goal, PENDING),
            ),
            "전략: %s"
            % need(
                spec, "strategy", default="영농 발전 및 리스크 대응 전략 [%s]" % PENDING
            ),
            "보완: %s"
            % need(
                spec,
                "follow_up",
                default="지도교수·심사위원·제출연월, 기상 실측, 관련 논문 서지 등 미비사항 보완 [%s]"
                % PENDING,
            ),
            "",
            "Ⅵ. 참고문헌",
            bibliography(spec),
            "감사의 글",
            need(
                spec,
                "acknowledgments",
                default="지도와 검토를 기록한다. 독립검토와 교수 승인은 이 글로 대체하지 않는다.",
            ),
            "",
        ]
    )
    return "\n".join(sections)


def paper(spec):
    """Generate the school paper, with an opt-in normalized frontmatter mode.

    Flat metadata continues to use the historical output byte-for-byte.  When
    ``school_profile`` is supplied, only the logical frontmatter is replaced by
    the official cover → title/submission → approval → TOC order; the I–VI body
    remains generated by the same implementation and receives profile values
    through a detached legacy-key overlay.
    """

    profile = normalize_school_profile(spec)
    if not profile.get("enabled"):
        return _legacy_paper(spec)

    merged = dict(spec)
    key_map = {
        "title": "title",
        "author": "author",
        "department": "major",
        "school": "school",
        "advisor": "advisor",
        "submission_date": "submitted",
    }
    for source, target in key_map.items():
        if profile.get(source):
            merged[target] = profile[source]
    legacy = _legacy_paper(merged)
    body_marker = "Ⅰ. 머리말"
    pos = legacy.find(body_marker)
    if pos < 0:
        raise ValueError("학교 본문 시작 표식 누락")
    body = legacy[pos:]
    # Replace the old frontmatter (including sample static TOC entries) with
    # the normalized form lines.  Dynamic page numbers are supplied by DOCX.
    front = frontmatter_lines(profile, artifacts=spec.get("frontmatter_artifacts"))
    return "\n".join(front + ["", body])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("base")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default="build/검토전_본문.md")
    a = ap.parse_args()
    try:
        src = local(a.base, a.input)
        out = local(a.base, a.out)
        if out.exists():
            raise ValueError("기존 산출물을 덮어쓰지 않음: 새 경로 지정")
        out.parent.mkdir(parents=True, exist_ok=True)
        spec = json.loads(src.read_text(encoding="utf-8"))
        if not isinstance(spec, dict):
            raise ValueError("논문 입력은 객체여야 함")
        spec.setdefault("school_profile", {"mode": "school", "layout": "forms_1_to_4"})
        text = paper(spec)
        out.write_text(text, encoding="utf-8")
        print(str(out))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as e:
        print(str(e))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
