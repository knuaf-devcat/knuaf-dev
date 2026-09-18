"""기존 python-docx 표의 숫자 셀 줄바꿈 방지 레이아웃 도우미.

학교 A4 세로 본문 영역(기본 150mm) 안에서 숫자 토큰이 3+1·5+1처럼 중간에
잘리지 않게 한다. 값은 한 글자도 바꾸지 않고, 머리글 반복(tblHeader)·행
분할 금지(cantSplit) 같은 행 속성은 그대로 둔다.

방법: 숫자 셀만 골라 필요 폭을 추정하고, 읽을 수 있는 범위(기본 9~10pt) 안의
글꼴 크기와 열 폭 재배분·셀 여백 축소·개별 셀 noWrap으로 해결한다. 글꼴을
최소치까지 줄이고 열을 재배분해도 세로 폭에 안 맞으면, 표가 속한 섹션이 세로일
때 한해 가로로 돌려 넓어진 본문 폭에 다시 맞춘다(allow_landscape, 기본 켜짐).
가로로도 안 맞으면 회전 없이 경고를 보고하며 noWrap은 유지해 숫자가 두 줄로
쪼개지는 것만은 막는다. 결과는 보고 dict로 돌려준다.
"""

import re

from docx.oxml.ns import qn
from docx.shared import Pt

MM_TO_DXA = 1440.0 / 25.4
PT_TO_MM = 25.4 / 72.0

_NUMERIC_CHARS = frozenset("0123456789,.-–−+()%'′\"")
_NUMERIC_RE = re.compile(r"^[+\-−–(]?\d[\d,\.'’\s]*[\d%)]$|^[+\-−–]?\d[%)]?$")

# 폰트를 몰라도 보수적으로(넓게) 재는 문자별 em 폭. 넓게 재야 실제로 맞는다.
# digit은 신명조 계열 실측으로 보정했다: 네이티브 PDF의 Batang 자폭 ≈0.59em,
# 시스템 AppleMyungjo(신명조) 자폭 ≈0.64em. 0.56은 실측보다 좁아 네 자리 수가
# 셀 안에서 3+1로 끊기는 원인이었다.
_EM_WIDTHS = {
    "digit": 0.65,
    "sep": 0.30,  # , . ' space
    "sign": 0.38,  # + - – −
    "pct": 0.85,  # %
    "paren": 0.36,  # ( )
    "other": 1.0,  # 원·한글 등 예상 밖 문자는 전각으로
}


def _char_em(ch):
    if ch.isdigit():
        return _EM_WIDTHS["digit"]
    if ch in ",.'’ ":
        return _EM_WIDTHS["sep"]
    if ch in "+-–−":
        return _EM_WIDTHS["sign"]
    if ch == "%":
        return _EM_WIDTHS["pct"]
    if ch in "()":
        return _EM_WIDTHS["paren"]
    return _EM_WIDTHS["other"]


def is_numeric_token(token):
    """공백으로 나눈 한 토큰이 순수 숫자 표기인지(1,234 / -54,747,807 / 0.38 / 38%)."""
    return bool(token) and bool(_NUMERIC_RE.match(token))


def _is_numeric_cell(cell):
    text = cell.text.strip()
    if not text:
        return False
    return all(is_numeric_token(t) for t in text.split())


def token_width_mm(token, font_pt):
    return sum(_char_em(c) for c in token) * font_pt * PT_TO_MM


def _cell_demand_mm(cell, font_pt):
    """noWrap 기준 수요: 단락마다 한 줄 전체 폭의 최대."""
    best = 0.0
    for para in cell.paragraphs:
        line = " ".join(para.text.split())
        if line:
            best = max(best, token_width_mm(line, font_pt))
    return best


# CJK·전각 문자는 글자 사이 어디서든 줄바꿈 가능 → 끊을 수 없는 단위는
# 비CJK 연속 구간(라틴·숫자·기호) 또는 한글 1자 폭이다.
_CJK_RE = re.compile(r"[ᄀ-ᅟ⺀-鿿가-힯＀-￯]")
_HARD_RUN_RE = re.compile(r"[^\sᄀ-ᅟ⺀-鿿가-힯＀-￯]+")

# 텍스트 셀은 tcMar를 줄이지 않으므로 워드 기본 좌우 여백(0.19cm)을 유지한다.
_TEXT_CELL_MARGIN_MM = 1.9


def _cell_actual_pt(cell, default_pt):
    for para in cell.paragraphs:
        for run in para.runs:
            if run.text.strip() and run.font.size is not None:
                return run.font.size.pt
    return default_pt


def _token_floor_em(token):
    """토큰이 쪼개지지 않는 최소 em 폭.

    Word는 CJK·비CJK 경계뿐 아니라 숫자 연속 구간 안에서도 끊는 것이 확인돼
    있다(월10 → 월1|0). 따라서 마지막 2자 이상 비CJK 구간의 *끝*까지 이어지는
    접두사 전체가 한 줄에 들어가야 한다 — 그 구간만 재면 0이 다음 줄로 밀린다.
    2자 이상 구간이 없으면 가장 긴 단일 구간 또는 한글 1자 폭이 floor다."""
    runs = [m for m in _HARD_RUN_RE.finditer(token)]
    long_runs = [m for m in runs if len(m.group()) > 1]
    if long_runs:
        end = long_runs[-1].end()
        return sum(_char_em(c) for c in token[:end])
    if runs:
        return max(sum(_char_em(c) for c in m.group()) for m in runs)
    if _CJK_RE.search(token):
        return 1.0
    return 0.0


def _cell_text_floor_mm(cell, default_pt):
    """텍스트 셀의 깨지지 않는 최소 폭(mm, 셀 여백 제외)."""
    pt = _cell_actual_pt(cell, default_pt)
    best = 0.0
    for token in cell.text.split():
        best = max(best, _token_floor_em(token) * pt * PT_TO_MM)
    return best


def _grid_span(cell):
    tcPr = cell._tc.tcPr
    if tcPr is None:
        return 1
    gs = tcPr.find(qn("w:gridSpan"))
    return int(gs.get(qn("w:val"))) if gs is not None else 1


def _set_dxa(parent, tag, dxa):
    """정수 dxa로 쓴다. 내림이라 열 폭 합계가 계산 영역을 넘지 않는다."""
    el = parent.find(qn(tag))
    if el is None:
        el = parent.makeelement(qn(tag), {})
        parent.append(el)
    el.set(qn("w:w"), str(int(dxa + 1e-6)))
    el.set(qn("w:type"), "dxa")
    return el


def _scan(table, font_pt, margin_mm, text_floor_mm):
    """열 단위 수요를 모은다.

    반환 (n_cols, floor, numeric_tcs, numeric_cols): floor[c]는 그 열이 절대
    좁아질 수 없는 폭 — 숫자 셀은 noWrap 한 줄 전체(주어진 font_pt 기준) +
    축소 셀 여백, 텍스트 셀은 실제 글꼴 기준 가장 긴 비CJK 구간 + 기본 셀
    여백. 숫자 열에 있는 머리글 텍스트(예: "1월")도 그 열의 floor를 올린다.
    row.cells는 grid 열당 하나씩 yield하므로(병합 tc는 반복) enumerate 위치가
    곧 열 번호다."""
    n_cols = len(table.columns)
    num_need = [0.0] * n_cols
    txt_need = [0.0] * n_cols
    has_text = [False] * n_cols
    numeric_tcs = {}  # tc element -> (first_col, span)
    seen = set()
    for row in table.rows:
        for col, cell in enumerate(row.cells):
            if col >= n_cols:
                break
            tc = cell._tc
            if tc in seen:
                continue
            seen.add(tc)
            span = _grid_span(cell)
            numeric = _is_numeric_cell(cell)
            if numeric:
                numeric_tcs[tc] = (col, span)
                demand = (_cell_demand_mm(cell, font_pt) + 2 * margin_mm) / span
                for c in range(col, min(col + span, n_cols)):
                    num_need[c] = max(num_need[c], demand)
            else:
                demand = (_cell_text_floor_mm(cell, font_pt)
                          + 2 * _TEXT_CELL_MARGIN_MM) / span
                for c in range(col, min(col + span, n_cols)):
                    txt_need[c] = max(txt_need[c], demand)
                    has_text[c] = True
    numeric_cols = [c for c in range(n_cols) if num_need[c] > 0]
    floor = [0.0] * n_cols
    for c in range(n_cols):
        floor[c] = max(num_need[c], txt_need[c])
        if has_text[c] and floor[c] < text_floor_mm:
            floor[c] = text_floor_mm
    return n_cols, floor, numeric_tcs, numeric_cols


def _existing_widths_mm(table, n_cols, text_area_mm):
    """현재 열 폭(mm)을 읽는다: tblGrid → 첫 tcW 행 → tblW/영역 균등 순."""
    grid = table._tbl.find(qn("w:tblGrid"))
    cols = grid.findall(qn("w:gridCol")) if grid is not None else []
    ws = [c.get(qn("w:w")) for c in cols]
    if len(ws) == n_cols and all(ws):
        return [int(w) / MM_TO_DXA for w in ws]
    for row in table.rows:  # gridSpan 없는 행의 tcW만 신뢰
        cells = row.cells
        if len(cells) < n_cols or any(_grid_span(c) != 1 for c in cells):
            continue
        widths = []
        for cell in cells[:n_cols]:
            tcPr = cell._tc.tcPr
            tcW = tcPr.find(qn("w:tcW")) if tcPr is not None else None
            if tcW is None or tcW.get(qn("w:type")) != "dxa" or not tcW.get(qn("w:w")):
                break
            widths.append(int(tcW.get(qn("w:w"))) / MM_TO_DXA)
        if len(widths) == n_cols:
            return widths
    total = text_area_mm
    tblW = table._tbl.tblPr.find(qn("w:tblW")) if table._tbl.tblPr is not None else None
    if tblW is not None and tblW.get(qn("w:type")) == "dxa" and tblW.get(qn("w:w")):
        total = int(tblW.get(qn("w:w"))) / MM_TO_DXA
    return [total / n_cols] * n_cols


def _allocate(floor, existing, text_area_mm):
    """열 폭 배분. 규칙:

    1. 기존 폭이 floor 이상이면 그대로 보존(기존 30mm 라벨 열 유지).
    2. Σtarget > 영역: floor 위 슬랙을 비율로 회수(텍스트 열에만 몰아주지
       않고 슬랙 있는 모든 열에서). 반환 (widths, fits, slack_by_col).
    3. Σtarget ≤ 영역: 남는 폭을 target 비율로 전 열에 배분해 영역을 채운다.
    """
    target = [max(e, f) for e, f in zip(existing, floor)]
    total = sum(target)
    if total <= text_area_mm + 1e-6:
        leftover = text_area_mm - total
        if leftover > 1e-6 and total > 0:
            widths = [t + leftover * t / total for t in target]
        else:
            widths = target
        return widths, True
    cut = total - text_area_mm
    slack = [t - f for t, f in zip(target, floor)]
    pool = sum(slack)
    if pool + 1e-9 >= cut:
        widths = [t - s * cut / pool for t, s in zip(target, slack)]
        return widths, True
    return target, False


def _governing_sectpr(table):
    """표가 속한 섹션의 sectPr — 본문 바로 아래 표만 지원한다.

    OOXML에서 sectPr는 그것이 끝내는 섹션 전체에 적용되므로, 표 뒤에 오는 첫
    sectPr가 곧 이 표의 섹션 정의다. 문서 순서대로 첫 일치를 반환한다."""
    body = table._tbl.getparent()
    if body is None or body.tag != qn("w:body"):
        return None
    seen = False
    for el in body.iter():
        if el is table._tbl:
            seen = True
        elif seen and el.tag == qn("w:sectPr"):
            return el
    return None


def _landscape_text_area_mm(table):
    """세로 섹션이면 가로 전환 시의 본문 폭(mm), 아니면 None. 돌리지는 않는다."""
    sectPr = _governing_sectpr(table)
    if sectPr is None:
        return None
    pgSz = sectPr.find(qn("w:pgSz"))
    if pgSz is None:
        return None
    w, h = pgSz.get(qn("w:w")), pgSz.get(qn("w:h"))
    if not w or not h or int(w) >= int(h):
        return None
    mar = 0
    pgMar = sectPr.find(qn("w:pgMar"))
    if pgMar is not None:
        mar = sum(int(pgMar.get(qn(e)) or 0) for e in ("w:left", "w:right"))
    return (int(h) - mar) / MM_TO_DXA


def _rotate_section_to_landscape(table):
    sectPr = _governing_sectpr(table)
    if sectPr is None:
        return False
    pgSz = sectPr.find(qn("w:pgSz"))
    if pgSz is None:
        return False
    w, h = pgSz.get(qn("w:w")), pgSz.get(qn("w:h"))
    if not w or not h or int(w) >= int(h):
        return False
    pgSz.set(qn("w:w"), h)
    pgSz.set(qn("w:h"), w)
    pgSz.set(qn("w:orient"), "landscape")
    return True


def fit_table(table, text_area_mm=150.0, max_font_pt=10.0, min_font_pt=9.0,
              cell_margin_mm=0.7, text_col_floor_mm=8.0, allow_landscape=True):
    """숫자 셀이 한 줄에 들어가도록 표 레이아웃을 조정한다. 보고 dict 반환.

    - 숫자 셀 없는 표는 건드리지 않는다 (applied=False).
    - 기존 열 폭이 그 열의 floor(숫자 한 줄 수요·머리글 텍스트 최소 폭) 이상이면
      그대로 보존한다 — 슬랙을 텍스트 열 하나에 몰아주지 않는다.
    - 글꼴은 max→min 0.5pt 단계로 낮춰 숫자 수요가 들어맞는 첫 크기 사용.
      그래도 안 맞으면 floor 아래로는 안 내리고 feasible=False로 정직하게 보고.
    - 세로 본문 폭에 최소 글꼴로도 안 맞는데 표의 섹션이 세로라면, 섹션을
      가로로 돌렸을 때의 본문 폭으로 한 번 더 내림차순 시도한다. 들어맞을 때만
      실제로 페이지 방향을 바꾼다(allow_landscape=False면 시도 자체를 생략).
    - 숫자 셀: tcW 재배정 + 좌우 여백 축소 + w:noWrap + run 글꼴 크기 조정.
    - 행 속성(tblHeader·cantSplit)·셀 텍스트는 변경하지 않는다.
    """
    report = {"applied": False, "feasible": None, "font_pt": None,
              "columns": None, "warnings": []}
    n_cols0, _, numeric_tcs, numeric_cols = _scan(
        table, max_font_pt, cell_margin_mm, text_col_floor_mm)
    if not numeric_cols:
        report["warnings"].append("no numeric cells found; table left untouched")
        return report
    n_cols = n_cols0
    existing = _existing_widths_mm(table, n_cols, text_area_mm)

    font_pt = None
    widths = None
    floor = None

    def _descend(area_mm):
        """max→min 0.5pt 하강: 들어맞는 첫 글꼴에서 (font_pt, widths)를 채운다."""
        nonlocal font_pt, widths, floor, n_cols
        candidate = max_font_pt
        while candidate >= min_font_pt - 1e-9:
            n_cols, floor, _, numeric_cols = _scan(
                table, candidate, cell_margin_mm, text_col_floor_mm)
            w, fits = _allocate(floor, existing, area_mm)
            if fits:
                font_pt, widths = candidate, w
                return True
            candidate = round(candidate - 0.5, 3)
        return False

    feasible = _descend(text_area_mm)
    rotated = False
    if not feasible and allow_landscape:
        land_area = _landscape_text_area_mm(table)
        if land_area is not None and _descend(land_area):
            if _rotate_section_to_landscape(table):
                rotated = True
                text_area_mm = land_area
                feasible = True
                report["warnings"].append(
                    "portrait text area could not hold whole tokens at >=%.1fpt; "
                    "section rotated to landscape" % min_font_pt)
    if font_pt is None:
        font_pt = min_font_pt
        n_cols, floor, _, numeric_cols = _scan(
            table, font_pt, cell_margin_mm, text_col_floor_mm)
        # floor 아래로는 안 내림: 최소치에서도 안 맞으면 floor 폭만 주고 보고.
        widths = floor
        report["warnings"].append(
            "numeric columns cannot fit %.1fmm even at %.1fpt; applied noWrap + "
            "floor widths, values preserved" % (text_area_mm, font_pt))
        if sum(widths) > text_area_mm + 1e-6:
            report["warnings"].append("allocated width still exceeds text area")

    tbl = table._tbl
    tblPr = tbl.tblPr
    _set_dxa(tblPr, "w:tblW", min(sum(widths), text_area_mm) * MM_TO_DXA)
    layout = tblPr.find(qn("w:tblLayout"))
    if layout is None:
        layout = tblPr.makeelement(qn("w:tblLayout"), {})
        tblPr.append(layout)
    layout.set(qn("w:type"), "fixed")

    grid = tbl.find(qn("w:tblGrid"))
    if grid is not None:
        for gc, w_mm in zip(grid.findall(qn("w:gridCol")), widths):
            gc.set(qn("w:w"), str(int(w_mm * MM_TO_DXA + 1e-6)))

    margin_dxa = int(round(cell_margin_mm * MM_TO_DXA))
    seen = set()
    for row in table.rows:
        for col, cell in enumerate(row.cells):
            if col >= n_cols:
                break
            tc = cell._tc
            if tc in seen:
                continue
            seen.add(tc)
            span = _grid_span(cell)
            tcPr = tc.get_or_add_tcPr()
            cell_w = sum(widths[col:col + span])
            _set_dxa(tcPr, "w:tcW", cell_w * MM_TO_DXA)
            if tc in numeric_tcs:
                tcMar = tcPr.find(qn("w:tcMar"))
                if tcMar is None:
                    tcMar = tcPr.makeelement(qn("w:tcMar"), {})
                    tcPr.append(tcMar)
                _set_dxa(tcMar, "w:left", margin_dxa)
                _set_dxa(tcMar, "w:right", margin_dxa)
                if tcPr.find(qn("w:noWrap")) is None:
                    tcPr.append(tcPr.makeelement(qn("w:noWrap"), {}))
                for para in cell.paragraphs:
                    for run in para.runs:
                        run.font.size = Pt(font_pt)
                        # 한글 문서에서 숫자가 complex-script 판정될 수 있어
                        # w:szCs도 함께 둔다(반pt 단위).
                        rPr = run._r.get_or_add_rPr()
                        szCs = rPr.find(qn("w:szCs"))
                        if szCs is None:
                            szCs = rPr.makeelement(qn("w:szCs"), {})
                            rPr.append(szCs)
                        szCs.set(qn("w:val"), str(int(round(font_pt * 2))))

    report.update({"applied": True, "feasible": feasible, "font_pt": font_pt,
                   "columns": [round(w, 2) for w in widths],
                   "rotated_to_landscape": rotated,
                   "text_area_mm": round(text_area_mm, 2)})
    return report


def fit_tables(tables, **kwargs):
    """여러 표에 fit_table을 적용하고 보고 dict 목록을 돌려준다."""
    return [fit_table(t, **kwargs) for t in tables]
