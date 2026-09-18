#!/usr/bin/env python3
"""Apply an explicit print-layout map to a new XLSX copy; never edit values or formulas."""
from __future__ import annotations
import argparse
import json
import math
import os
import re
import sys
import zipfile
from pathlib import Path
from gg_excel_template import (NS_MAIN, NS_MC, _serialize_dom, _dom_elements, workbook_sheets,
                                 sha256, expand_ref, col_num)

SCHEMA = 'gg-xlsx-print-map/v1'
MAX_ROW = 1_048_576
MAX_COL = 16_384
MAX_ROW_HEIGHT = 409.5
CELL_REF_RE = re.compile(r'^\$?([A-Z]{1,3})\$?([1-9]\d*)$')
SUPPORTED_PLAN_KEYS = {'sheet', 'fit_width', 'fit_height', 'orientation', 'print_area', 'row_breaks', 'reason', 'row_heights', 'wrap_cells', 'source_note_cells', 'number_formats', 'print_titles'}

def qualified(doc, root, name):
    return doc.createElementNS(NS_MAIN, (root.prefix + ':' if root.prefix else '') + name)

def _cell_ref(value):
    if not isinstance(value, str):
        raise ValueError('cell reference must be a string')
    m = CELL_REF_RE.fullmatch(value.upper())
    if not m:
        raise ValueError(f'invalid cell reference: {value!r}')
    col, row = m.group(1), int(m.group(2))
    if col_num(col) > MAX_COL or row > MAX_ROW:
        raise ValueError(f'cell reference outside Excel range: {value!r}')
    return f'{col}{row}', row


def _row_heights(plan):
    entries = plan.get('row_heights')
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ValueError('row_heights must be a list')
    out = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'row', 'height'}:
            raise ValueError('row_heights entries require only row and height')
        row = entry['row']; height = entry['height']
        if type(row) is not int or row < 1 or row > MAX_ROW:
            raise ValueError('row_heights row must be an existing positive Excel row')
        if isinstance(height, bool) or not isinstance(height, (int, float)) or not math.isfinite(height) or not (0 < height <= MAX_ROW_HEIGHT):
            raise ValueError('row_heights height must be finite and in (0, 409.5]')
        if row in seen:
            raise ValueError('row_heights rows must be unique')
        seen.add(row); out.append((row, height))
    return out


def _wrap_cells(plan):
    cells = plan.get('wrap_cells')
    if cells is None:
        return []
    if not isinstance(cells, list):
        raise ValueError('wrap_cells must be a list')
    out = []; seen = set()
    for value in cells:
        ref, _ = _cell_ref(value)
        if ref in seen:
            raise ValueError('wrap_cells must be unique')
        seen.add(ref); out.append(ref)
    return out


def _direct_children(node, local_name):
    return [child for child in node.childNodes
            if child.nodeType == child.ELEMENT_NODE
            and child.namespaceURI == NS_MAIN and child.localName == local_name]


def _style_wrap_cells(styles_doc, sheet_doc, cells, note_color=None, number_format=None):
    if not cells:
        return []
    roots = _dom_elements(styles_doc, NS_MAIN, 'cellXfs')
    if len(roots) != 1:
        raise ValueError('exactly one styles cellXfs required for wrap_cells')
    cell_xfs = roots[0]
    # Do not guess MC branch selection. A Choice+Fallback pair can expose two
    # different effective style sequences for the same index, so fail closed.
    for alternate in _dom_elements(cell_xfs, NS_MC, 'AlternateContent'):
        branches = [child for child in alternate.childNodes
                    if child.nodeType == child.ELEMENT_NODE
                    and child.namespaceURI == NS_MC
                    and child.localName in {'Choice', 'Fallback'}]
        xf_branches = [branch for branch in branches
                       if _dom_elements(branch, NS_MAIN, 'xf')]
        if len(xf_branches) > 1:
            raise ValueError('ambiguous AlternateContent branches in cellXfs')
    # cellXfs may contain MC AlternateContent wrappers; style indices count all
    # effective descendant xfs in document order, not only direct children.
    xfs = _dom_elements(cell_xfs, NS_MAIN, 'xf')
    if not xfs:
        raise ValueError('styles cellXfs is empty')
    sheet_cells = {c.getAttribute('r').upper().replace('$', ''): c
                   for c in _dom_elements(sheet_doc, NS_MAIN, 'c') if c.hasAttribute('r')}
    # A merged non-anchor has no independent display cell in Excel.
    nonanchors = set()
    for merged in _dom_elements(sheet_doc, NS_MAIN, 'mergeCell'):
        ref = merged.getAttribute('ref')
        nonanchors.update(expand_ref(ref)[1:])
    changes = []
    for ref in cells:
        if ref not in sheet_cells:
            raise ValueError(f'wrap_cells references missing cell: {ref}')
        if ref in nonanchors:
            raise ValueError(f'wrap_cells cannot target merged non-anchor: {ref}')
        cell = sheet_cells[ref]
        raw_style = cell.getAttribute('s') if cell.hasAttribute('s') else '0'
        try:
            style_id = int(raw_style)
        except ValueError:
            raise ValueError(f'invalid style index on {ref}: {raw_style!r}')
        if style_id < 0 or style_id >= len(xfs):
            raise ValueError(f'style index outside cellXfs on {ref}: {style_id}')
        clone = xfs[style_id].cloneNode(deep=True)
        if number_format is not None:
            if number_format == '#,##0':
                clone.setAttribute('numFmtId', '3')
            elif number_format == '0':
                clone.setAttribute('numFmtId', '1')
            elif number_format == '0.00%':
                clone.setAttribute('numFmtId', '10')
            elif number_format == '#,##0.00':
                clone.setAttribute('numFmtId', '4')
            else:
                raise ValueError('only #,##0, 0, 0.00% and #,##0.00 formats are supported')
            clone.setAttribute('applyNumberFormat', '1')
        if note_color is not None:
            if cell.getAttribute('t') not in {'s', 'inlineStr'} or _dom_elements(cell, NS_MAIN, 'f'):
                raise ValueError('source_note_cells must target text, not numbers or formulas')
            font_roots = _dom_elements(styles_doc, NS_MAIN, 'fonts')
            if len(font_roots) != 1:
                raise ValueError('source note styling requires one fonts collection')
            fonts = _direct_children(font_roots[0], 'font')
            font_id = int(clone.getAttribute('fontId') or '0')
            if not 0 <= font_id < len(fonts):
                raise ValueError('source note font index outside fonts')
            font = fonts[font_id].cloneNode(deep=True)
            for color in _direct_children(font, 'color'):
                font.removeChild(color)
            color = qualified(styles_doc, font, 'color')
            color.setAttribute('rgb', note_color)
            font.appendChild(color)
            font_roots[0].appendChild(font)
            font_roots[0].setAttribute('count', str(len(fonts) + 1))
            clone.setAttribute('fontId', str(len(fonts)))
            clone.setAttribute('applyFont', '1')
        clone.setAttribute('applyAlignment', '1')
        alignments = _direct_children(clone, 'alignment')
        if alignments:
            alignment = alignments[0]
            for extra in alignments[1:]:
                clone.removeChild(extra)
        else:
            prefix = clone.prefix or cell_xfs.prefix or styles_doc.documentElement.prefix
            alignment = styles_doc.createElementNS(NS_MAIN, (prefix + ':' if prefix else '') + 'alignment')
            protection = next((child for child in clone.childNodes
                               if child.nodeType == child.ELEMENT_NODE
                               and child.namespaceURI == NS_MAIN
                               and child.localName in {'protection', 'extLst'}), None)
            if protection is None:
                clone.appendChild(alignment)
            else:
                clone.insertBefore(alignment, protection)
        alignment.setAttribute('wrapText', '1')
        new_style = len(xfs)
        cell_xfs.appendChild(clone)
        xfs.append(clone)
        cell.setAttribute('s', str(new_style))
        changes.append({'cell': ref, 'old_style': style_id, 'new_style': new_style, 'wrap_text': True})
        if note_color is not None:
            changes[-1]['font_color'] = note_color
        if number_format is not None:
            changes[-1]['number_format'] = number_format
    cell_xfs.setAttribute('count', str(len(xfs)))
    return changes


def apply(source, map_path, out, receipt_path):
    source, map_path, out, receipt_path = map(Path, (source, map_path, out, receipt_path))
    paths = [p.resolve() for p in (source, map_path, out, receipt_path)]
    if len(set(paths)) != 4: raise ValueError('source, map, output, and receipt must be different')
    if out.exists() or receipt_path.exists(): raise FileExistsError('refusing overwrite')
    data = json.loads(map_path.read_text())
    if data.get('schema') != SCHEMA or data.get('source', {}).get('sha256') != sha256(source):
        raise ValueError('print map schema/source hash mismatch')
    plans = data.get('sheets')
    if not isinstance(plans, list) or not plans: raise ValueError('nonempty sheets required')
    modifications = {}; changes = []; seen = set(); styles_doc = None; style_changes = []
    with zipfile.ZipFile(source) as z:
        sheets = dict(workbook_sheets(z))
        book = _serialize_dom(z.read('xl/workbook.xml'), 'xl/workbook.xml')
        order = list(sheets)
        for plan in plans:
            if not isinstance(plan, dict): raise ValueError('sheet plans must be objects')
            unknown_keys = set(plan) - SUPPORTED_PLAN_KEYS
            if unknown_keys: raise ValueError('unknown sheet-plan keys: ' + ','.join(sorted(unknown_keys)))
            name = plan.get('sheet')
            if name not in sheets or name in seen: raise ValueError('missing or duplicate sheet')
            seen.add(name)
            if not isinstance(plan.get('reason'), str) or not plan['reason'].strip(): raise ValueError('reason required')
            width, height = plan.get('fit_width'), plan.get('fit_height')
            if type(width) is not int or type(height) is not int or width < 1 or height < 0: raise ValueError('invalid fit counts')
            orientation = plan.get('orientation')
            if orientation is not None and orientation not in ('portrait', 'landscape'): raise ValueError('invalid orientation')
            area = plan.get('print_area')
            if area is not None:
                if not isinstance(area, str) or not re.fullmatch(r'\$?[A-Z]{1,3}\$?[1-9]\d*:\$?[A-Z]{1,3}\$?[1-9]\d*', area):
                    raise ValueError('single cell rectangle required')
                left, right = area.split(':', 1)
                left_ref, left_row = _cell_ref(left); right_ref, right_row = _cell_ref(right)
                left_col = col_num(re.match(CELL_REF_RE, left_ref).group(1)); right_col = col_num(re.match(CELL_REF_RE, right_ref).group(1))
                if left_col > right_col or left_row > right_row:
                    raise ValueError('print_area range must be ordered')
            titles = plan.get('print_titles')
            if titles is not None:
                if not isinstance(titles, dict) or set(titles) != {'rows'}:
                    raise ValueError('print_titles requires only rows')
                rows_spec = titles['rows']
                if not isinstance(rows_spec, list) or not rows_spec or any(type(x) is not int or x < 1 or x > MAX_ROW for x in rows_spec):
                    raise ValueError('print_titles rows must be nonempty positive integers')
                if rows_spec != sorted(rows_spec) or len(set(rows_spec)) != len(rows_spec):
                    raise ValueError('print_titles rows must be strictly increasing')
                existing = [n for n in _dom_elements(book, NS_MAIN, 'definedName')
                            if n.getAttribute('name') == '_xlnm.Print_Titles' and n.getAttribute('localSheetId') == str(order.index(name))]
                if len(existing) > 1:
                    raise ValueError('multiple print_titles already defined for sheet')
                if len(rows_spec) == 1:
                    ref_str = "'" + name.replace("'", "''") + "'!$" + str(rows_spec[0]) + ":$" + str(rows_spec[0])
                else:
                    ref_str = "'" + name.replace("'", "''") + "'!$" + str(rows_spec[0]) + ":$" + str(rows_spec[-1])
                if existing:
                    dn = existing[0]
                    while dn.firstChild:
                        dn.removeChild(dn.firstChild)
                    dn.appendChild(book.createTextNode(ref_str))
                else:
                    dn_list = _dom_elements(book, NS_MAIN, 'definedName')
                    dn = qualified(book, book.documentElement, 'definedName')
                    dn.setAttribute('name', '_xlnm.Print_Titles')
                    dn.setAttribute('localSheetId', str(order.index(name)))
                    dn.appendChild(book.createTextNode(ref_str))
                    if dn_list:
                        dn_list[-1].parentNode.insertBefore(dn, dn_list[-1].nextSibling)
                    else:
                        broot = book.documentElement
                        sheets_el = _dom_elements(broot, NS_MAIN, 'sheets')
                        anchor = sheets_el[0] if sheets_el else broot.firstChild
                        anchor.parentNode.insertBefore(dn, anchor.nextSibling)
            row_heights = _row_heights(plan)

            wrap_cells = _wrap_cells(plan)
            note_cells = _wrap_cells({'wrap_cells': plan.get('source_note_cells')})
            doc = _serialize_dom(z.read(sheets[name]), sheets[name]); root = doc.documentElement
            pr_nodes = _dom_elements(doc, NS_MAIN, 'sheetPr')
            pr = pr_nodes[0] if pr_nodes else qualified(doc, root, 'sheetPr')
            if not pr_nodes: root.insertBefore(pr, root.firstChild)
            setups = _dom_elements(pr, NS_MAIN, 'pageSetUpPr')
            setup_pr = setups[0] if setups else qualified(doc, root, 'pageSetUpPr')
            if not setups: pr.appendChild(setup_pr)
            setup_pr.setAttribute('fitToPage', '1')
            setups = _dom_elements(doc, NS_MAIN, 'pageSetup')
            setup = setups[0] if setups else qualified(doc, root, 'pageSetup')
            if not setups:
                after = {'headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'}
                next_node = next((n for n in root.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName in after), None)
                root.insertBefore(setup, next_node) if next_node else root.appendChild(setup)
            before = dict(setup.attributes.items())
            if setup.hasAttribute('scale'): setup.removeAttribute('scale')
            setup.setAttribute('fitToWidth', str(width)); setup.setAttribute('fitToHeight', str(height))
            if orientation: setup.setAttribute('orientation', orientation)
            if area:
                # Existing template print area only: do not invent workbook names.
                names = [n for n in _dom_elements(book, NS_MAIN, 'definedName') if n.getAttribute('name') == '_xlnm.Print_Area' and n.getAttribute('localSheetId') == str(order.index(name))]
                if len(names) != 1: raise ValueError('exactly one existing print area required')
                old_area = ''.join(n.data for n in names[0].childNodes if n.nodeType == n.TEXT_NODE)
                while names[0].firstChild: names[0].removeChild(names[0].firstChild)
                names[0].appendChild(book.createTextNode("'" + name.replace("'", "''") + "'!" + area))
            else: old_area = None
            row_nodes = {int(n.getAttribute('r')): n for n in _dom_elements(doc, NS_MAIN, 'row') if n.hasAttribute('r')}
            if titles is not None and any(r not in row_nodes for r in rows_spec):
                raise ValueError('print_titles rows must exist in the sheet')
            missing_rows = [row for row, _ in row_heights if row not in row_nodes]
            if missing_rows:
                raise ValueError('row_heights references missing row: ' + ','.join(map(str, missing_rows)))
            before_row_heights = []
            for row, height_value in row_heights:
                node = row_nodes[row]
                before_row_heights.append({'row': row, 'height': node.getAttribute('ht') if node.hasAttribute('ht') else None,
                                           'customHeight': node.getAttribute('customHeight') if node.hasAttribute('customHeight') else None})
                node.setAttribute('ht', str(height_value))
                node.setAttribute('customHeight', '1')
            wrap_changes = []
            number_formats = plan.get('number_formats', [])
            if not isinstance(number_formats, list):
                raise ValueError('number_formats must be a list')
            if wrap_cells or note_cells or number_formats:
                if styles_doc is None:
                    try:
                        styles_doc = _serialize_dom(z.read('xl/styles.xml'), 'xl/styles.xml')
                    except KeyError:
                        raise ValueError('styles.xml required for wrap_cells')
                wrap_changes = _style_wrap_cells(styles_doc, doc, wrap_cells)
                wrap_changes.extend(_style_wrap_cells(styles_doc, doc, note_cells, 'FF666666'))
                for override in number_formats:
                    if not isinstance(override, dict) or set(override) != {'cells', 'format'}:
                        raise ValueError('number format override requires cells and format')
                    cells = _wrap_cells({'wrap_cells': override['cells']})
                    wrap_changes.extend(_style_wrap_cells(
                        styles_doc, doc, cells, number_format=override['format']
                    ))
                style_changes.extend({'sheet': name, **item} for item in wrap_changes)
            else:
                wrap_changes = []
            breaks = plan.get('row_breaks')
            old_breaks = [n.toxml() for n in _dom_elements(doc, NS_MAIN, 'rowBreaks')]
            if breaks is not None:
                if not isinstance(breaks, list) or any(type(x) is not int or x < 1 or x > MAX_ROW for x in breaks) or len(set(breaks)) != len(breaks): raise ValueError('row_breaks must be unique positive integers in Excel range')
                if height != 0: raise ValueError('manual row breaks require fit_height 0')
                from openpyxl.utils.cell import range_boundaries
                for merged in _dom_elements(doc, NS_MAIN, 'mergeCell'):
                    _, first_row, _, last_row = range_boundaries(merged.getAttribute('ref'))
                    if any(first_row <= row < last_row for row in breaks): raise ValueError('row break splits a merged cell')
                for n in list(_dom_elements(doc, NS_MAIN, 'rowBreaks')): n.parentNode.removeChild(n)
                if breaks:
                    container = qualified(doc, root, 'rowBreaks'); container.setAttribute('count', str(len(breaks))); container.setAttribute('manualBreakCount', str(len(breaks)))
                    for row in sorted(breaks):
                        br = qualified(doc, root, 'brk')
                        for k,v in {'id':row,'min':0,'max':16383,'man':1}.items(): br.setAttribute(k,str(v))
                        container.appendChild(br)
                    after = {'colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'}
                    next_node = next((n for n in root.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName in after),None)
                    root.insertBefore(container,next_node) if next_node else root.appendChild(container)
            modifications[sheets[name]] = doc.toxml(encoding='utf-8')
            changes.append({'sheet': name, 'before_page_setup': before, 'after_page_setup':dict(setup.attributes.items()), 'fitToPage_after':True, 'old_print_area': old_area, 'old_row_breaks':old_breaks, 'row_height_changes': [{'row': row, 'old': old, 'new': {'height': height_value, 'customHeight': '1'}} for (row, height_value), old in zip(row_heights, before_row_heights)], 'wrap_cell_changes': wrap_changes, 'requested': plan})
        modifications['xl/workbook.xml'] = book.toxml(encoding='utf-8')
        if styles_doc is not None:
            modifications['xl/styles.xml'] = styles_doc.toxml(encoding='utf-8')
        out.parent.mkdir(parents=True, exist_ok=True); receipt_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name('.' + out.name + '.tmp-' + str(os.getpid()))
        rtmp = receipt_path.with_name('.' + receipt_path.name + '.tmp-' + str(os.getpid()))
        if tmp.exists() or rtmp.exists(): raise FileExistsError('staging collision')
        published = False
        try:
            with zipfile.ZipFile(tmp, 'x', compression=zipfile.ZIP_DEFLATED) as dest:
                for info in z.infolist(): dest.writestr(info, modifications.get(info.filename, z.read(info.filename)))
            receipt = {'schema':'gg-xlsx-print-receipt/v1', 'source': {'path':str(source.resolve()),'sha256':sha256(source)}, 'map':{'path':str(map_path.resolve()),'sha256':sha256(map_path)}, 'output':{'path':str(out.resolve()),'sha256':sha256(tmp)}, 'changes':changes, 'scope':'explicitly listed sheets only', 'cell_changes':0, 'style_changes':style_changes, 'visual_validation':'required'}
            rtmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
            os.replace(tmp, out); published = True
            os.replace(rtmp, receipt_path)
        except Exception:
            if published: out.unlink(missing_ok=True)
            tmp.unlink(missing_ok=True); rtmp.unlink(missing_ok=True)
            raise
    return receipt

def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('source','map','out','receipt'): p.add_argument('--'+name, required=True, type=Path)
    a = p.parse_args()
    try:
        r = apply(a.source, a.map, a.out, a.receipt)
        print(json.dumps({'status':'layout_copy_created','output':r['output'],'sheets':len(r['changes'])}))
        return 0
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as e:
        print('BLOCK: ' + str(e), file=sys.stderr); return 2
if __name__ == '__main__': raise SystemExit(main())
