#!/usr/bin/env python3
"""Low-level DOCX preview exporter. No submission or font/render approval implied."""

import argparse
import io
import json
from pathlib import Path
import re
import sys
from docx import Document
from docx.shared import Pt, Mm, RGBColor, Twips
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from gg_document import parse, spans, SCI, FRONT, school_toc_range, school_frontmatter_plan
from gg_core import atomic, digest, local
import gg_docx_table_layout

FONT = "신명조"
# 소제목(6~9단계: (1)/(가)/①/㉮)은 gg_school_format의 OG-016 허용 범위
# (13~18pt) 최소치인 13pt로 둔다. 12pt는 본문과 같아 검사에서 차단된다.
LEVEL_PT = {1: 20, 2: 18, 3: 16, 4: 14, 5: 13, 6: 13, 7: 13, 8: 13, 9: 13}


def set_font(run, name, size_pt, bold=False, color=(0, 0, 0)):
    run.font.name, run.font.size, run.bold = name, Pt(size_pt), bold
    run.italic = False
    run.font.color.rgb = RGBColor(*color)
    rf = run._element.get_or_add_rPr().get_or_add_rFonts()
    for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
        rf.set(qn("w:" + attr), name)


def runs(p, text, font, size=12, bold=False, color=(0, 0, 0)):
    # Keep long reference URLs intact in the DOCX relationship instead of
    # leaving the last digit stranded on a printed line.
    url_match = re.search(r"https?://[^\s]+", text)
    if url_match and len(url_match.group(0)) > 65:
        from docx.opc.constants import RELATIONSHIP_TYPE as RT
        url = url_match.group(0)
        runs(p, text[:url_match.start()], font, size, bold, color)
        link = OxmlElement("w:hyperlink")
        link.set(qn("r:id"), p.part.relate_to(url, RT.HYPERLINK, is_external=True))
        run = OxmlElement("w:r"); props = OxmlElement("w:rPr")
        fonts=OxmlElement("w:rFonts")
        for key in ("ascii", "hAnsi", "eastAsia", "cs"): fonts.set(qn("w:"+key),font)
        props.append(fonts)
        sz=OxmlElement("w:sz");sz.set(qn("w:val"),str(size*2));props.append(sz)
        col=OxmlElement("w:color");col.set(qn("w:val"),"000000");props.append(col)
        run.append(props);label=OxmlElement("w:t");label.text="원문 링크";run.append(label);link.append(run);p._p.append(link)
        runs(p, text[url_match.end():], font, size, bold, color)
        return
    # Scientific genus/species only; author and infraspecific rank remain roman.
    tokens = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|" + SCI.pattern + r")")
    pos = 0
    for m in tokens.finditer(text):
        if m.start() > pos:
            set_font(p.add_run(text[pos : m.start()]), font, size, bold, color)
        token = m[0]
        r = p.add_run(token.strip("*"))
        set_font(r, font, size, bold or token.startswith("**"), color)
        r.italic = not token.startswith("**")
        pos = m.end()
    if pos < len(text):
        set_font(p.add_run(text[pos:]), font, size, bold, color)


def _toc_style(doc, name, size=12, bold=False, indent=0):
    try:
        style = doc.styles[name]
    except KeyError:
        style = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
    style.font.name = FONT
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.paragraph_format.left_indent = Pt(indent)
    style.paragraph_format.space_after = Pt(0)
    style.paragraph_format.tab_stops.add_tab_stop(
        Mm(150), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS
    )
    return style


def add_toc(doc, font, max_level=9):
    """Insert a dynamic TOC with official hierarchy and dot leaders."""
    _toc_style(doc, "TOC 1", 12, True, 0)
    _toc_style(doc, "TOC 2", 11, False, 14)
    _toc_style(doc, "TOC 3", 11, False, 24)
    toc = doc.add_paragraph()
    runs(toc, "목차", font, 20, True)
    toc.paragraph_format.keep_with_next = True
    toc.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), f'TOC \\o "1-{max_level}" \\h \\z \\u \\t "Heading 1,1,Heading 2,2,Heading 3,3"')
    field.set(qn("w:dirty"), "true")
    toc_field = doc.add_paragraph()
    toc_field._p.append(field)
    return toc, toc_field


def _bottom_border(p):
    ppr = p._p.get_or_add_pPr()
    borders = ppr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        ppr.append(borders)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "000000")
    borders.append(bottom)


def setup_document(doc, font):
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = font, Pt(12)
    normal.font.color.rgb = RGBColor(0, 0, 0)
    normal.paragraph_format.line_spacing = 1.6
    normal.paragraph_format.space_after = Pt(0)
    for s in doc.sections:
        s.page_width, s.page_height = Mm(210), Mm(297)
        s.top_margin, s.bottom_margin = Mm(20), Mm(15)
        s.left_margin, s.right_margin = Mm(30), Mm(30)
        s.header_distance, s.footer_distance = Mm(15), Mm(15)


def add_table(doc, rows, font):
    merges = spans(rows)
    t = doc.add_table(rows=len(rows), cols=len(rows[0]))
    t.style, t.alignment, t.autofit = "Table Grid", WD_TABLE_ALIGNMENT.CENTER, False
    count = len(rows[0])
    is_climate = any(
        any(
            k in (r[0] if r else "")
            for k in ("평균기온", "최고기온", "최저기온", "강우량", "풍속", "적설량")
        )
        for r in rows
    )
    if count >= 10:
        widths = [30] + [106 / (count - 2)] * (count - 2) + [14]
    elif is_climate:
        metric_w = 32.5
        val_w = (150 - metric_w) / (count - 1)
        widths = [metric_w] + [val_w] * (count - 1)
    else:
        widths = [150 / count] * count
    widths = [Mm(width).twips for width in widths]
    widths[-1] += Mm(150).twips - sum(widths)
    for col, width in zip(t.columns, widths):
        col.width = Twips(width)
    compact_climate = is_climate and count >= 10
    pad = "14" if is_climate else "28"
    for i, row in enumerate(rows):
        trpr = t.rows[i]._tr.get_or_add_trPr()
        trpr.append(OxmlElement("w:cantSplit"))
        if i == 0:
            trpr.append(OxmlElement("w:tblHeader"))
        for j, text in enumerate(row):
            c = t.cell(i, j)
            c.width = Twips(widths[j])
            margins = OxmlElement("w:tcMar")
            for edge in ("left", "right"):
                margin = OxmlElement("w:" + edge)
                margin.set(qn("w:w"), pad)
                margin.set(qn("w:type"), "dxa")
                margins.append(margin)
            c._tc.get_or_add_tcPr().append(margins)
            if i == 0:
                for p in c.paragraphs:
                    p.paragraph_format.keep_with_next = True
            if text not in {"^", "<"}:
                p = c.paragraphs[0]
                if compact_climate:
                    p.paragraph_format.line_spacing = 1.0
                    p.paragraph_format.space_before = Pt(0)
                    p.paragraph_format.space_after = Pt(0)
                runs(p, text, font, 9 if compact_climate else 12, i == 0)
    for r0, c0, r1, c1 in merges:
        t.cell(r0, c0).merge(t.cell(r1, c1))
    return t


WIDE_TABLE_MIN_COLS = 10

# 목차 항목으로 인정하는 줄: 원고 목차에 적힌 제목 줄과 고정 표제. 뒤에 점선·
# 쪽번호가 붙어도 목차 항목으로 본다. 그 밖의 문단·표·그림은 본문 앞에서
# 조용히 버려지므로 fail-closed로 거부한다.
_TOC_LABEL_RE = re.compile(
    r"^(목차|요약|표 목차|그림 목차|감사의 글|참고문헌|부록)"
    r"(\s*[.·…]*\s*[ivxⅰ-ⅹ\d]*)$"
)


def _toc_like(n):
    if n["kind"] == "heading":
        return True
    if n["kind"] == "paragraph" and not n.get("list_item"):
        return bool(_TOC_LABEL_RE.match(n.get("text", "").strip()))
    return False


def _node_label(n):
    if n["kind"] == "table":
        return "[표 " + " ".join(n["rows"][0])[:30] + "]"
    if n["kind"] == "image":
        return "[그림 " + n.get("path", "") + "]"
    return n.get("text", "")


def check_dropped_nodes(nodes, i_toc, i_body, rendered=()):
    """목차와 본문 사이에서 렌더되지 않는 내용이 있으면 ValueError.

    ``rendered``는 이 구간에서 실제로 출력되는 노드(요약 절 등)다. 목차 항목
    (제목 줄·고정 표제)은 목차 필드로 다시 만들어지므로 버려도 된다."""
    kept = {id(n) for n in rendered}
    dropped = [n for n in nodes[i_toc + 1:i_body]
               if id(n) not in kept and not _toc_like(n)]
    if dropped:
        shown = [_node_label(n).strip()[:40] for n in dropped[:3]]
        more = " 외 %d개" % (len(dropped) - 3) if len(dropped) > 3 else ""
        raise ValueError("목차 뒤 렌더되지 않는 내용: " + " | ".join(shown) + more)
    return []


def convert(md_text, font=FONT, base=".", table_reports=None):
    doc = Document()
    setup_document(doc, font)
    nodes = parse(md_text)

    last_prose = None

    def render_node(n, allow_soft_wrap=False):
        nonlocal last_prose
        prose = n["kind"] == "paragraph" and not n.get("list_item")
        if allow_soft_wrap and prose and n.get("soft_continue") and last_prose is not None:
            runs(last_prose, " " + n["text"], font, 12)
            return
        last_prose = None
        if n["kind"] == "table":
            t = add_table(doc, n["rows"], font)
            # Wide body tables only: re-fit numeric cells to the current
            # section's real text width. Frontmatter forms (built by
            # gg_frontmatter_layout) and small tables are untouched.
            if len(n["rows"][0]) >= WIDE_TABLE_MIN_COLS:
                sec = doc.sections[-1]
                text_area_mm = (
                    sec.page_width.mm
                    - sec.left_margin.mm
                    - sec.right_margin.mm
                )
                # A4 세로를 유지한다: 가로 회전은 절 전체 pgSz를 바꾸므로
                # 금지하고, 안 맞으면 feasible=False로 보고만 한다.
                rep = gg_docx_table_layout.fit_table(
                    t, text_area_mm=text_area_mm, allow_landscape=False
                )
                rep["n_cols"] = len(n["rows"][0])
                if rep.get("applied") and rep.get("feasible") is False:
                    rep["warnings"].append(
                        "표(%d열)가 A4 세로 본문 폭에 맞지 않음: 열 축소·분할 필요"
                        % rep["n_cols"]
                    )
                if table_reports is not None:
                    table_reports.append(rep)
        elif n["kind"] == "image":
            p = (Path(base) / n["path"]).resolve()
            if not p.is_relative_to(Path(base).resolve()) or not p.is_file():
                raise ValueError("그림 파일 없음/외부 경로: " + n["path"])
            doc.add_picture(str(p), width=Mm(145))
            picture_paragraph = doc.paragraphs[-1]
            picture_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            picture_paragraph.paragraph_format.keep_with_next = True
        else:
            heading = n["kind"] == "heading"
            list_item = n.get("list_item", False)
            p = doc.add_paragraph(
                style="Heading " + str(n["level"]) if heading else None
            )
            pf = p.paragraph_format
            pf.line_spacing = 1.6
            pf.keep_with_next = heading or (
                n["kind"] == "caption" and n["label"] == "표"
            )
            pf.widow_control = True
            pf.space_after = Pt(6 if heading else 0)
            text = n["text"]
            if list_item:
                pf.left_indent = Pt(24)
                pf.first_line_indent = Pt(-12)
                pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
                text = "• " + text
            elif not heading and n["kind"] != "caption":
                pf.first_line_indent = Pt(24)
                pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            if n["kind"] == "caption":
                pf.alignment = (WD_ALIGN_PARAGRAPH.CENTER if n["label"] == "그림"
                                else WD_ALIGN_PARAGRAPH.LEFT)
                pf.first_line_indent = Pt(0)
            runs(p, text, font, LEVEL_PT[n["level"]] if heading else 12, heading)
            if n.get("_bookmark"):
                from gg_frontmatter_layout import bookmark
                bookmark(p, n["_bookmark"], n["_bookmark_id"])
            if prose:
                last_prose = p

    front_plan = school_frontmatter_plan(nodes)
    front_indices = front_plan["indices"] if front_plan else {}
    is_school_paper = front_plan is not None

    if not is_school_paper:
        # 표·그림만 있고 제목이 없는 문서에 빈 목차 페이지를 붙이지 않는다.
        if any(n["kind"] == "heading" for n in nodes):
            add_toc(doc, font)
            update = OxmlElement("w:updateFields")
            update.set(qn("w:val"), "true")
            doc.settings.element.append(update)
            doc.add_page_break()
        for n in nodes:
            render_node(n, allow_soft_wrap=True)
        return doc

    update = OxmlElement("w:updateFields")
    update.set(qn("w:val"), "true")
    doc.settings.element.append(update)

    i_appr = front_indices["인준서"]
    i_title = front_indices["표제면"]
    i_subm = front_indices["제출서"]
    i_toc, i_body = school_toc_range(nodes)
    official_forms_order = bool(front_plan.get("official_order"))
    if official_forms_order:
        from gg_frontmatter_layout import render_forms
        render_forms(doc, nodes, front_plan, font)
    else:
        # 1. 겉표지 (Cover): 관리용 절 제목 "겉표지"는 출력에서 제외하고,
        # 학교 양식대로 중앙 정렬 + 글자 위계(제목 강조)로 배치한다.
        cover_end = min(i_appr, i_title, i_subm, i_toc)
        cover_size = {"농업전문학사 학위논문": 18, "영농창업계획": 16}
        cover_lines = [n for n in nodes[0:cover_end] if n.get("text", "").strip() not in {"", "겉표지"}]
        for idx, n in enumerate(cover_lines):
            text = n.get("text", "").strip()
            if not text or text == "겉표지":
                continue
            p = doc.add_paragraph()
            pf = p.paragraph_format
            pf.line_spacing = 1.0
            pf.alignment = WD_ALIGN_PARAGRAPH.CENTER
            if idx == 0:
                # Measured cover baselines: degree ≈58 mm from page top.
                pf.space_before = Pt(90)
                runs(p, text, font, cover_size.get(text, 18), True if text.endswith("학위논문") else False,
                     (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))
            elif text in {"영농창업계획", "영농 승계 발전계획"}:
                pf.space_before = Pt(65)
                runs(p, text, font, 16, False, (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))
            elif idx == 2:
                pf.space_before = Pt(38)
                pf.space_after = Pt(18)
                runs(p, text, font, 22 if len(text) < 34 else 18, True,
                     (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))
            else:
                if text.endswith("년 2월") or text.endswith("년 1월") or text.endswith("년 12월"):
                    # Date baseline ≈181 mm; a supplied graduation date is used as
                    # is and never copied from the submission date.
                    pf.space_before = Pt(100)
                elif text in {"한국농수산대학교", "한국농수산대학"}:
                    pf.space_before = Pt(62)
                elif text == "특용작물전공" or text.endswith("학과"):
                    pf.space_before = Pt(8)
                else:
                    pf.space_before = Pt(8)
                runs(p, text, font, 14, False, (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))
        doc.add_page_break()

        def render_form_slice(seq, *, approval=False, hide_marker=False, official=False):
            approval_rows = 0
            seen_plan = False
            title_candidates = 0
            for n in seq:
                text = n.get("text", "").strip()
                if not text:
                    continue
                if hide_marker and text in {"인준서", "표제면", "제출서"}:
                    continue
                p = doc.add_paragraph()
                pf = p.paragraph_format
                pf.alignment = WD_ALIGN_PARAGRAPH.CENTER
                pf.line_spacing = 1.0 if official else 1.6
                pf.space_after = Pt(8)
                if text in {"인준서", "표제면", "제출서"}:
                    runs(p, text, font, 20, True)
                    pf.space_before = Pt(25)
                    pf.keep_with_next = True
                elif approval and (text.startswith("위원장 ") or text.startswith("위  원 ")):
                    pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
                    pf.left_indent = Mm(35)
                    pf.right_indent = Mm(35)
                    # 서명란이 다음 페이지로 넘어가지 않도록 간격을 확정적으로 줄인다.
                    pf.space_before = Pt(80 if approval_rows == 0 else 40)
                    pf.space_after = Pt(10)
                    # A right tab keeps the (인) mark at the form's right edge;
                    # each paragraph receives its own border and vertical gap.
                    pf.tab_stops.add_tab_stop(Mm(100), WD_TAB_ALIGNMENT.RIGHT)
                    text = text.replace(" (인)", "\t(인)")
                    runs(p, text, font, 14, False,
                         (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))
                    _bottom_border(p)
                    approval_rows += 1
                else:
                    if official and not approval:
                        # Baselines mirror the measured school example (A4 page;
                        # body starts below the 20 mm top margin).  Spacing is
                        # relative to the preceding line so long titles still wrap
                        # naturally without absolute-positioned text boxes.
                        if text.startswith("지도교수 "):
                            pf.space_before = Pt(48)
                        elif text == "농업전문학사 학위논문":
                            pf.space_before = Pt(8)
                        elif text in {"영농창업계획", "영농 승계 발전계획"}:
                            pf.space_before = Pt(95)
                            seen_plan = True
                        elif text.startswith("이 논문을"):
                            pf.space_before = Pt(120)
                        elif text.endswith("년 12월") or text.endswith("년 11월"):
                            pf.space_before = Pt(8)
                        elif text in {"한국농수산대학교", "한국농수산대학"}:
                            pf.space_before = Pt(95)
                        elif text == "특용작물전공" or text.endswith("학과"):
                            pf.space_before = Pt(18)
                        elif seen_plan and title_candidates < 2 and text not in {
                            "농업전문학사 학위논문", "영농창업계획", "이 논문을 농업전문학사 학위논문으로 제출함"
                        }:
                            # Optional subtitle followed by the thesis title.
                            pf.space_before = Pt(40)
                            title_candidates += 1
                        elif text and text not in {"농업전문학사 학위논문", "영농창업계획"}:
                            pf.space_before = Pt(12)
                    elif approval:
                        if text.endswith("인준함"):
                            pf.space_before = Pt(88)
                        elif re.search(r"\d{4}년\s*\d{1,2}월", text):
                            pf.space_before = Pt(82)
                    runs(p, text, font, 15 if approval else 14, False,
                         (0, 0, 255) if "[확인 필요]" in text else (0, 0, 0))

        # Legacy logical order retained for existing Markdown and tests.
        render_form_slice(nodes[i_appr:i_title], approval=True)
        doc.add_page_break()
        render_form_slice(nodes[i_title:i_subm])
        doc.add_page_break()
        # 제출서는 학교 양식 제출 문구를 기본 서식으로 두고 저작된 검토
        # 메모를 함께 표시한다.
        subm_seq = nodes[i_subm:i_toc]
        if not any("양식에 따라 제출" in n.get("text", "") for n in subm_seq):
            subm_seq = subm_seq[:1] + [
                {
                    "kind": "paragraph",
                    "text": "이 영농창업계획을 학교 양식에 따라 제출한다.",
                }
            ] + subm_seq[1:]
        render_form_slice(subm_seq)
        doc.add_page_break()

    if official_forms_order:
        from gg_frontmatter_layout import contents, bookmark
        body_nodes=nodes[i_body:]
        for n in body_nodes:
            if n.get("text", "").strip()=="감사의 글":
                n["kind"]="heading";n["level"]=1
        for idx,n in enumerate(body_nodes,1):
            if n['kind'] in {'heading','caption'}:
                n['_bookmark']='gg_body_'+str(idx)
                n['_bookmark_id']=idx
        prelim=[]
        candidates=nodes[i_toc+1:i_body]
        summary_start=next((i for i,n in enumerate(candidates) if n.get('text','').strip()=='요약'),None)
        if summary_start is not None:
            for n in candidates[summary_start+1:]:
                text=n.get('text','').strip()
                if text in {'표 목차','그림 목차','감사의 글'} or re.match(r'^[ⅠI]\s*[.．].*머리말',text): break
                prelim.append(n)
        check_dropped_nodes(nodes, i_toc, i_body, prelim)
        table_entries=[(n['text'],n['_bookmark'],2) for n in body_nodes if n['kind']=='caption' and n.get('label')=='표']
        figure_entries=[(n['text'],n['_bookmark'],2) for n in body_nodes if n['kind']=='caption' and n.get('label')=='그림']
        entries=[]
        if prelim: entries.append(('요약','gg_summary',0))
        if table_entries: entries.append(('표 목차','gg_tables',0))
        if figure_entries: entries.append(('그림 목차','gg_figures',0))
        entries += [(n['text'],n['_bookmark'],n['level']) for n in body_nodes if n['kind']=='heading' and n['level']<=2]
        contents(doc,entries,font)
        def new_numbered_section(number_format):
            sec=doc.add_section(WD_SECTION.NEW_PAGE)
            pg=OxmlElement('w:pgNumType');pg.set(qn('w:start'),'1');pg.set(qn('w:fmt'),number_format);sec._sectPr.append(pg)
            sec.footer.is_linked_to_previous=False
            p=sec.footer.paragraphs[0];p.alignment=WD_ALIGN_PARAGRAPH.CENTER
            field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');p._p.append(field)
            return sec
        if prelim or table_entries or figure_entries:
            new_numbered_section('lowerRoman')
            if prelim:
                p=doc.add_paragraph();p.alignment=WD_ALIGN_PARAGRAPH.CENTER
                runs(p,'요약',font,20,True);bookmark(p,'gg_summary',9001)
                for n in prelim: render_node(n,allow_soft_wrap=True)
            if table_entries:
                if prelim: doc.add_page_break()
                contents(doc,table_entries,font,'표 목차','gg_tables',9002)
            if figure_entries:
                if prelim or table_entries: doc.add_page_break()
                contents(doc,figure_entries,font,'그림 목차','gg_figures',9003)
        new_numbered_section('decimal')
    else:
        # 목차 필드 앞의 원고 목차 항목만 버린다; 그 외 내용은 거부한다.
        check_dropped_nodes(nodes, i_toc, i_body)
        add_toc(doc,font)
        # 본문은 새 구역에서 1쪽부터 아라비아 숫자 쪽번호를 매긴다.
        sec = doc.add_section(WD_SECTION.NEW_PAGE)
        pg = OxmlElement('w:pgNumType'); pg.set(qn('w:start'), '1'); pg.set(qn('w:fmt'), 'decimal')
        sec._sectPr.append(pg)
        sec.footer.is_linked_to_previous = False
        fp = sec.footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE'); fp._p.append(field)

    # 6. Main Body
    for n in nodes[i_body:]:
        render_node(n, allow_soft_wrap=True)

    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("base")
    ap.add_argument("--in", dest="inp", default="build/본문_통합.md")
    ap.add_argument("--out", default="build/검토전_논문.docx")
    ap.add_argument("--font", default=FONT)
    a = ap.parse_args()
    try:
        src = local(a.base, a.inp)
        out = local(a.base, a.out)
        manifest_path = out.with_suffix(".manifest.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.exists():
            raise ValueError("기존 산출물을 덮어쓰지 않음: 새 경로 지정")
        if manifest_path.exists():
            raise ValueError("기존 산출물을 덮어쓰지 않음: " + manifest_path.name)
        source_text = src.read_text(encoding="utf-8")
        table_reports = []
        buf = io.BytesIO()
        convert(source_text, a.font, Path(a.base),
                table_reports=table_reports).save(buf)
        docx_bytes = buf.getvalue()
        parsed_plan = school_frontmatter_plan(parse(source_text))
        infeasible = [r for r in table_reports
                      if r.get("applied") and r.get("feasible") is False]
        warnings = [w for r in table_reports for w in r.get("warnings", ())
                    if r.get("applied") and r.get("feasible") is False]
        manifest = {
            "kind": "draft",
            "table_layout": {
                "status": "infeasible_fit" if infeasible else "ok",
                "wide_tables_checked": len(table_reports),
                "infeasible_count": len(infeasible),
                "reports": table_reports,
            },
            "warnings": warnings,
            "dropped_nodes": [],
            "file_hash": digest(docx_bytes),
            "input_hash": digest(src.read_bytes()),
            "font": a.font,
            "font_available": "not_run",
            "toc_update": "not_run",
            "render": "not_run",
            "hwp": "not_run",
            "school_frontmatter": (
                {
                    "layout": "forms_1_to_4" if parsed_plan.get("official_order") else "logical_legacy",
                    "order": list(parsed_plan.get("order", ())),
                    "source_order_note": (
                        "공식 지침 p4 논리 순서와 p6–9 시각 예시 순서가 달라 forms_1_to_4를 선택함"
                        if parsed_plan.get("official_order")
                        else "공식 지침 p4 논리 순서를 사용함; p6–9 시각 예시와 다를 수 있어 사용자 검토 필요"
                    ),
                }
                if parsed_plan
                else None
            ),
            "notice": "저수준 미검증 출력. 목차 필드 갱신·전체 페이지·학교 원문·학명·그림·표·머리행 검토 필요. 한글에서 글꼴 신명조·여백(위20/아래15/머리15/꼬리15/좌30/우30/제본0 mm)·페이지 번호를 확인한다. 이 세 가지는 스킬 작성 완료를 막지 않으며 자동 통과하지 않는다.",
        }
        # 스테이징 파일에 쓴 뒤 os.replace: 중단돼도 반쪽짜리 .docx가 남지 않는다.
        atomic(out, docx_bytes)
        atomic(manifest_path,
               json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        for w in warnings:
            print("경고: " + w, file=sys.stderr)
        print(str(out))
        return 0
    except (ValueError, OSError) as e:
        print(str(e))
        return 2


if __name__ == "__main__":
    sys.exit(main())
