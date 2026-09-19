#!/usr/bin/env python3
"""Fail-closed OOXML format probe for school manuscript outputs.

This checker supports DOCX files generated with the school body bookmark. It measures the
DOCX package as XML (including style inheritance) and never rewrites it.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from zipfile import BadZipFile, ZipFile
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
QN = lambda local: "{%s}%s" % (W, local)
A4 = (11906, 16838)  # twips, 210 x 297 mm

class ProbeError(ValueError):
    pass

def attr(node, name, default=None):
    if node is None:
        return default
    if isinstance(node, dict):
        return node.get(QN(name), node.get(name, default))
    return node.attrib.get(QN(name), default)

def text_of(p):
    # Preserve text order, but ignore field instructions and drawing metadata.
    return "".join(x.text or "" for x in p.iter(QN("t"))).replace("\u00a0", " ")

def props(node, children):
    out = {}
    if node is None:
        return out
    for child in list(node):
        local = child.tag.rsplit("}", 1)[-1]
        if local in children:
            out[local] = dict(child.attrib)
    return out

def merge_props(base, overlay):
    out = {k: dict(v) for k, v in base.items()}
    for k, v in overlay.items():
        old = out.get(k, {})
        old.update(v)
        out[k] = old
    return out

class Styles:
    def __init__(self, root):
        self.styles = {}
        self.default_para = None
        self.defaults_p = {}
        self.defaults_r = {}
        dd = root.find(QN("docDefaults"))
        if dd is not None:
            self.defaults_p = props(dd.find("./" + QN("pPrDefault") + "/" + QN("pPr")), {"spacing", "ind", "jc"})
            self.defaults_r = props(dd.find("./" + QN("rPrDefault") + "/" + QN("rPr")), {"sz", "rFonts", "b", "i", "bCs", "szCs"})
        for st in root.findall(QN("style")):
            sid = attr(st, "styleId")
            if not sid:
                continue
            self.styles[sid] = {
                "based": attr(st.find(QN("basedOn")), "val"),
                "p": props(st.find(QN("pPr")), {"spacing", "ind", "jc"}),
                "outline": attr(st.find("./" + QN("pPr") + "/" + QN("outlineLvl")), "val"),
                "r": props(st.find(QN("rPr")), {"sz", "rFonts", "b", "i", "bCs", "szCs"}),
                "name": attr(st.find(QN("name")), "val"),
                "type": attr(st, "type"),
            }
            if attr(st, "default") == "1" and attr(st, "type") == "paragraph":
                self.default_para = sid

    def chain(self, sid):
        seen = set(); result = []
        while sid and sid not in seen:
            seen.add(sid)
            st = self.styles.get(sid)
            if st is None: break
            result.append((sid, st)); sid = st["based"]
        return list(reversed(result))

    def paragraph(self, p):
        direct = p.find(QN("pPr"))
        sid = attr(direct.find(QN("pStyle")), "val") if direct is not None else None
        if sid is None:
            sid = self.default_para
        pprops = dict(self.defaults_p)
        rprops = dict(self.defaults_r)
        for _, st in self.chain(sid):
            pprops = merge_props(pprops, st["p"])
            rprops = merge_props(rprops, st["r"])
        pprops = merge_props(pprops, props(direct, {"spacing", "ind", "jc"}))
        st = self.styles.get(sid, {})
        outline = None
        # outlineLvl is style metadata, not a paragraph property in our merge set.
        for csid, cst in self.chain(sid):
            node = cst.get("outline")
            if node is not None: outline = node
        return sid, pprops, rprops, {"name": st.get("name"), "outline_level": outline}

    def run(self, p, base_r):
        values = []
        for r in p.iter(QN("r")):
            if not r.findall(".//" + QN("t")):
                continue
            rp = r.find(QN("rPr"))
            merged = dict(base_r)
            rstyle = attr(rp.find(QN("rStyle")), "val") if rp is not None and rp.find(QN("rStyle")) is not None else None
            for _, st in self.chain(rstyle):
                if st.get("type") == "character": merged = merge_props(merged, st["r"])
            values.append(merge_props(merged, props(rp, {"sz", "rFonts", "b", "i", "bCs", "szCs"})))
        return values

def is_heading(style_id, txt, rec=None):
    if rec is not None and (rec.get("outline_level") is not None or (rec.get("style_name") or "").lower().startswith("heading")):
        return True
    if style_id in {"1", "21", "31"}:
        return True
    return bool(re.match(r"^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|\d+[.)]|[가-힣]\.)\s*", txt)) and len(txt) < 100

def heading_group(rec):
    lvl = rec.get("outline_level")
    name = (rec.get("style_name") or "").lower()
    if lvl == "0" or "heading 1" in name or rec.get("style_id") == "1":
        return "large"
    if lvl == "1" or "heading 2" in name or rec.get("style_id") == "21":
        return "middle"
    if lvl is not None or "heading" in name or rec.get("style_id") == "31":
        return "sub"
    txt = rec.get("text", "").strip()
    if re.match(r"^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.", txt): return "large"
    if re.match(r"^\d+\.", txt): return "middle"
    return "sub"

def classify(txt, table, front_done, toc_done):
    if table:
        return "table"
    if not front_done:
        return "front"
    if not toc_done:
        if txt.strip() in {"목    차", "목차", "표 목차", "그림 목차"} or txt.strip().endswith(("목차", "목 차")):
            return "toc"
        # TOC rows have trailing page number and precede summary/body.
        if re.search(r"(?:[ⅠⅡⅢⅣⅤⅥ]+\.|\d+\.|[가-힣]\.)[^\n]{0,100}\d+$", txt.strip()):
            return "toc"
    return "body"

def walk_paragraphs(parent, context, out):
    """Walk paragraphs while retaining table/row/cell path."""
    for child in list(parent):
        local = child.tag.rsplit("}", 1)[-1]
        if local == "p":
            out.append((child, context))
        elif local == "tbl":
            ti = context.get("table_index", 0) + 1
            rows = child.findall("./" + QN("tr"))
            for ri, row in enumerate(rows, 1):
                cells = row.findall("./" + QN("tc"))
                for ci, cell in enumerate(cells, 1):
                    walk_paragraphs(cell, {"table": True, "table_index": ti, "row": ri, "cell": ci, "front": context.get("front", False)}, out)
        elif local == "tr":
            ti = context.get("table_index", 1)
            ri = context.get("row", 0) + 1
            for ci, cell in enumerate(child.findall("./" + QN("tc")), 1):
                walk_paragraphs(cell, {"table": True, "table_index": ti, "row": ri, "cell": ci, "front": context.get("front", False)}, out)
        elif local in {"sdtContent", "txbxContent", "customXml", "smartTag"}:
            walk_paragraphs(child, context, out)

def location(i, ctx):
    if ctx.get("table"):
        return f"document.xml:p{i} table#{ctx['table_index']} row#{ctx['row']} cell#{ctx['cell']}"
    return f"document.xml:p{i} body"

def paragraph_record(i, p, ctx, styles):
    txt = text_of(p)
    sid, pp, base_r, meta = styles.paragraph(p)
    runs = styles.run(p, base_r)
    size_values = sorted({attr(r.get("sz"), "val") for r in runs if r.get("sz") and attr(r.get("sz"), "val") is not None})
    fonts = sorted({f for f in (attr(r.get("rFonts"), "eastAsia") or attr(r.get("rFonts"), "ascii") or attr(r.get("rFonts"), "hAnsi") for r in runs if r.get("rFonts")) if f})
    bold_values = sorted({"on" if ("b" in r and attr(r.get("b"), "val", "true") not in {"0", "false", "off", "none"}) else "off" for r in runs})
    spacing = pp.get("spacing", {}); ind = pp.get("ind", {}); jc = pp.get("jc", {})
    return {
        "index": i, "location": location(i, ctx), "text": txt[:160],
        "bookmark_names": [attr(b, "name") for b in p.findall(".//" + QN("bookmarkStart")) if attr(b, "name")],
        "style_id": sid, "style_name": meta.get("name"), "outline_level": meta.get("outline_level"), "table": bool(ctx.get("table")),
        "size_half_points": size_values, "fonts_declared": fonts,
        "bold": bold_values,
        "line": attr(spacing, "line"), "line_rule": attr(spacing, "lineRule"),
        "first_line_twips": attr(ind, "firstLine"), "left_twips": attr(ind, "left"), "hanging_twips": attr(ind, "hanging"),
        "alignment": attr(jc, "val", "left"),
    }

def check(path: Path, *, output_json: Path | None = None):
    if not path.is_file(): raise ProbeError(f"missing DOCX: {path}")
    if output_json is not None and output_json.resolve() == path.resolve():
        raise ProbeError("--out must differ from input DOCX (refusing overwrite)")
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    try:
        with ZipFile(path) as z:
            names = set(z.namelist())
            for required in ("word/document.xml", "word/styles.xml"):
                if required not in names: raise ProbeError(f"missing OOXML part: {required}")
            doc = ET.fromstring(z.read("word/document.xml"))
            styles = Styles(ET.fromstring(z.read("word/styles.xml")))
    except (BadZipFile, ET.ParseError) as e:
        raise ProbeError(f"invalid DOCX OOXML: {e}") from e
    body = doc.find(".//" + QN("body"))
    if body is None: raise ProbeError("missing w:body")
    # Frontmatter ends after the first three top-level tables; this mirrors the
    # accepted school sequence while leaving all measurement evidence visible.
    top_tables = [x for x in list(body) if x.tag == QN("tbl")]
    front_table_limit = min(3, len(top_tables))
    records=[]; top_table_seen=0
    raw=[]
    for child in list(body):
        if child.tag == QN("tbl"):
            top_table_seen += 1
            walk_paragraphs(child, {"table": True, "table_index": top_table_seen, "front": top_table_seen <= front_table_limit}, raw)
            continue
        if child.tag == QN("p"):
            raw.append((child, {"table": False, "front": False}))
    # Reclassify by the renderer's body bookmarks.  The pre-body run contains
    # cover/signature tables, TOC fields, and summary; ``gg_body_1`` is the
    # first actual chapter and is safer than guessing from page-number text.
    body_start = next((j for j,(p,_) in enumerate(raw,1) if any((attr(b, "name") or "") == "gg_body_1" for b in p.findall(".//" + QN("bookmarkStart")))), None)
    summary_start = next((j for j,(p,ctx) in enumerate(raw,1) if not ctx.get("table") and text_of(p).strip() == "요약"), None)
    structural_violations = []
    if body_start is None:
        structural_violations.append({"requirement_id":"OG-004","code":"body_bookmark_missing","location":"word/document.xml","expected":"bookmark gg_body_1","actual":None,"message":"본문 시작 bookmark가 없어 본문 서식 검사를 수행할 수 없음"})
    for i,(p,ctx) in enumerate(raw,1):
        if ctx.get("table") and ctx.get("front"):
            kind="front"
        elif ctx.get("table"):
            kind="table"
        elif body_start is not None and i >= body_start:
            kind="body"
        elif summary_start is not None and i >= summary_start:
            kind="summary"
        else:
            kind="toc"
        rec=paragraph_record(i,p,ctx,styles); rec["kind"]=kind
        records.append(rec)
    body_records=[r for r in records if body_start is not None and r["kind"]=="body" and r["text"].strip() and not is_heading(r["style_id"],r["text"].strip(),r) and not r["text"].strip().startswith(("표 ","그림 "))]
    if body_start is not None and not body_records:
        structural_violations.append({"requirement_id":"OG-005","code":"body_prose_missing","location":"word/document.xml","expected":"at least one body prose paragraph","actual":0,"message":"본문 시작 bookmark 뒤 산문 문단이 없어 본문 서식을 검증할 수 없음"})
    table_records=[r for r in records if r["kind"]=="table" and r["text"].strip()]
    summary_records=[r for r in records if r["kind"]=="summary" and r["text"].strip()]
    front_records=[r for r in records if r["kind"]=="front" and r["text"].strip()]
    toc_records=[r for r in records if r["kind"]=="toc" and r["text"].strip()]
    summary_prose=[r for r in summary_records if r["text"].strip() not in {"요약","목차","표 목차","그림 목차"} and not is_heading(r["style_id"], r["text"].strip(), r) and not r["text"].strip().startswith(("표 ","그림 "))]
    violations=list(structural_violations)
    def add(req, code, rec, expected, actual, message):
        violations.append({"requirement_id":req,"code":code,"location":rec["location"],"text":rec["text"],"expected":expected,"actual":actual,"message":message})
    # A4 check every section property, including paragraph-level section breaks.
    sections=[]
    for si,sp in enumerate(doc.findall(".//"+QN("sectPr")),1):
        pg=sp.find(QN("pgSz")); got=(attr(pg,"w"),attr(pg,"h"))
        sections.append({"index":si,"size_twips":got,"a4":got==(str(A4[0]),str(A4[1]))})
        if got != (str(A4[0]),str(A4[1])):
            violations.append({"requirement_id":"OG-002","code":"not_a4","location":f"document.xml:sectPr#{si}","expected":{"w":str(A4[0]),"h":str(A4[1])},"actual":{"w":got[0],"h":got[1]}})
    if not sections:
        violations.append({"requirement_id": "OG-002", "code": "page_size_missing", "location": "word/document.xml", "message": "용지 크기를 검증할 section 정보가 없음"})
    for rec in body_records:
        if rec["size_half_points"] != ["24"]:
            add("OG-005","body_size",rec,{"size_half_points":["24"]},rec["size_half_points"],"본문 run의 상속 계산 글자 크기가 12 pt가 아님")
        if rec["line"] != "384" or rec["line_rule"] != "auto":
            add("OG-004","line_spacing",rec,{"line":"384","line_rule":"auto"},{"line":rec["line"],"line_rule":rec["line_rule"]},"본문 줄간격이 160% (384 twips auto)가 아님")
        # Lists/references intentionally carry hanging indents; record them as
        # measured exceptions rather than misreporting them as prose failures.
        list_exception = rec["hanging_twips"] not in (None, "0") or rec["text"].lstrip().startswith(("•","- "))
        if not list_exception and rec["first_line_twips"] != "480":
            add("OG-013","first_line_indent",rec,{"first_line_twips":"480"},rec["first_line_twips"],"본문 문단 첫 줄이 2칸(480 twips)이 아님")
    align_counts=Counter(r["alignment"] for r in body_records)
    # The instruction says mixed alignment; preserve the actual distribution and
    # require both alignment for prose; rendered appearance is reviewed separately.
    alignment_bad=[r for r in body_records if r["alignment"] != "both"]
    for rec in alignment_bad:
        add("OG-014","alignment_not_both",rec,"both",rec["alignment"],"본문 산문 정렬이 양쪽 정렬(both)이 아님")
    # Heading declarations, with font installation deliberately not inferred.
    heading_records=[r for r in records if r["kind"]=="body" and not r["table"] and is_heading(r["style_id"],r["text"].strip(),r) and r["text"].strip()]
    heading_groups={"large":[],"middle":[],"sub":[]}
    for r in heading_records:
        g=heading_group(r)
        heading_groups[g].append(r)
    heading_summary={}
    for g,items in heading_groups.items():
        sizes=Counter(tuple(x["size_half_points"]) for x in items); fonts=Counter(tuple(x["fonts_declared"]) for x in items); bold=Counter(tuple(x["bold"]) for x in items)
        heading_summary[g]={"count":len(items),"size_half_points":dict((str(k),v) for k,v in sizes.items()),"fonts_declared":dict((str(k),v) for k,v in fonts.items()),"bold_declarations":dict((str(k),v) for k,v in bold.items()),"font_installation":"not_checked"}
    # A heading requirement is visual: report measured failures but do not claim
    # installed-font or rendered-bold status from OOXML alone.
    for g,req,allowed in (("large","OG-015",{"40"}), ("middle","OG-016",{"26","28","30","32","34","36"}), ("sub","OG-016",{"26","28","30","32","34","36"})):
        for rec in heading_groups[g]:
            if not rec["size_half_points"] or not set(rec["size_half_points"]).issubset(allowed): add(req,"heading_size",rec,sorted(allowed),rec["size_half_points"],"제목 크기가 지침 범위를 벗어남")
            if rec["fonts_declared"] != ["신명조"]: add(req,"heading_font",rec,"신명조",rec["fonts_declared"],"제목 선언 글꼴이 신명조가 아님")
            if rec["bold"] != ["on"]: add(req,"heading_bold",rec,"bold declaration",rec["bold"],"제목에 w:b 선언이 없음")
    # Body font (OG-017) includes inherited Normal style font.
    body_font_violations=[]
    for rec in body_records:
        if rec["fonts_declared"] != ["신명조"]: body_font_violations.append(rec)
    for rec in body_font_violations: add("OG-017","body_font",rec,"신명조",rec["fonts_declared"],"본문 선언 글꼴이 신명조가 아님")
    if not body_records:
        for req in ("OG-004", "OG-005", "OG-013", "OG-014", "OG-017"):
            if not any(v["requirement_id"] == req for v in violations):
                violations.append({"requirement_id": req, "code": "body_unavailable", "location": "word/document.xml", "message": "검사 가능한 본문 산문 없음"})
    machine={
      "OG-002":{"status":"pass" if sections and all(s["a4"] for s in sections) else "blocked","measured_sections":sections},
      "OG-004":{"status":"pass" if not any(v["requirement_id"]=="OG-004" for v in violations) else "blocked","body_paragraph_count":len(body_records)},
      "OG-005":{"status":"pass" if not any(v["requirement_id"]=="OG-005" for v in violations) else "blocked","body_paragraph_count":len(body_records)},
      "OG-013":{"status":"pass" if not any(v["requirement_id"]=="OG-013" for v in violations) else "blocked","body_paragraph_count":len(body_records),"list_or_reference_exceptions":sum(1 for r in body_records if r["left_twips"] is not None or r["hanging_twips"] is not None)},
      "OG-014":{"status":"pass" if not any(v["requirement_id"]=="OG-014" for v in violations) else "blocked","alignment_counts":dict(align_counts),"prose_alignment_expected":"both","mixed_alignment_observed":len(align_counts)>1,"interpretation":"본문 산문은 both(양쪽 정렬)를 요구; 분포와 혼합 여부를 보존하고 명시 없는 문단만 차단"},
    }
    visual={
      "OG-015":{"status":"blocked" if any(v["requirement_id"]=="OG-015" for v in violations) else "pass_with_notes","heading_group":"large","requirement":"신명조 20 pt 굵게","measurement":heading_summary["large"]},
      "OG-016":{"status":"blocked" if any(v["requirement_id"]=="OG-016" for v in violations) else "pass_with_notes","heading_groups":["middle","sub"],"measurement":{"middle":heading_summary["middle"],"sub":heading_summary["sub"]}},
      "OG-017":{"status":"blocked" if any(v["requirement_id"]=="OG-017" for v in violations) else "pass_with_notes","body_font":"신명조 declared; installation not_checked","body_paragraph_count":len(body_records)},
    }
    result={"schema":"gg-school-format-probe/v1","status":"blocked" if violations else "pass_with_notes","input":{"path":str(path),"sha256":sha},"parts":{"body_paragraphs":len(body_records),"table_paragraphs":len(table_records),"front_paragraphs":len(front_records),"summary_paragraphs":len(summary_records),"summary_prose_paragraphs":len(summary_prose),"toc_paragraphs":len(toc_records)},"checks":{"machine":machine,"visual":visual},"heading_styles":heading_summary,"summary_prose_measurement":{"count":len(summary_prose),"size_half_points":{str(k):v for k,v in Counter(tuple(r["size_half_points"]) for r in summary_prose).items()},"line":{str(k):v for k,v in Counter((r["line"],r["line_rule"]) for r in summary_prose).items()},"first_line_twips":dict(Counter(r["first_line_twips"] for r in summary_prose)),"alignment":dict(Counter(r["alignment"] for r in summary_prose))},"violations":violations,"notes":["OOXML 선언과 style inheritance를 측정했으며 installed font와 실제 렌더링은 이 helper가 주장하지 않음.","표지·목차·표 셀은 본문 12 pt/160%/2칸 판정에서 제외하고 별도 계수로 보존함."]}
    if output_json:
        output_json.parent.mkdir(parents=True,exist_ok=True); output_json.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return result

def main(argv=None):
    ap=argparse.ArgumentParser(); ap.add_argument("docx",type=Path); ap.add_argument("--out",type=Path)
    ns=ap.parse_args(argv)
    try: result=check(ns.docx,output_json=ns.out)
    except (ProbeError,OSError) as e: print(f"BLOCK: {e}",file=sys.stderr); return 2
    print(json.dumps({"status":result["status"],"sha256":result["input"]["sha256"],"violations":len(result["violations"]),"out":str(ns.out) if ns.out else None},ensure_ascii=False))
    return 1 if result["status"]=="blocked" else 0
if __name__ == "__main__": raise SystemExit(main())
