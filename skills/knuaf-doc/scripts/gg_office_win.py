#!/usr/bin/env python3
"""Windows-only Office COM automation helper for gg_office.py.

Invoked as a bounded-timeout subprocess by gg_office.py's run_windows_com()
(never imported in-process): a hung COM session must not be able to block
the parent CLI past its --timeout, so the parent applies subprocess-level
timeout/kill semantics identical to the macOS osascript path.

Mirrors the exact operation sequence of the macOS AppleScript templates
(WORD_APPLESCRIPT_TEMPLATE / EXCEL_APPLESCRIPT_TEMPLATE in gg_office.py) so
both platforms produce equivalent receipts:
  Word:  open -> (repaginate + update all fields) x2 -> repaginate -> save
         -> export PDF -> save again (persist refreshed field caches) -> close
  Excel: open -> full workbook recalculation -> save -> export PDF -> close

Requires pywin32 (pip install pywin32) and a real Microsoft Word/Excel
desktop install. Not importable/usable on non-Windows platforms; every
entry point checks sys.platform before touching win32com.

NOTE: this file has not been exercised against a live Windows + Office
install in this development environment (macOS). The call sequence mirrors
well-documented, stable Word/Excel COM Object Model members (Repaginate,
Fields.Update, ExportAsFixedFormat, Application.CalculateFullRebuild,
Workbook.ExportAsFixedFormat). Verify with "python scripts/gg_office.py
doctor" and one real word/excel run on a Windows machine before relying on
this path for a live submission.
"""

from __future__ import annotations

import json
import sys


def _fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    sys.exit(code)


def run_word(input_path: str, pdf_path: str) -> None:
    import pythoncom
    import win32com.client as win32

    pythoncom.CoInitialize()
    word = None
    doc = None
    try:
        # DispatchEx always creates a NEW, private Word instance. EnsureDispatch
        # would attach to the student's running Word, and Quit() below would
        # then close their open documents with alerts suppressed (audit C6).
        word = win32.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0  # wdAlertsNone
        doc = word.Documents.Open(input_path)
        for _ in range(2):
            doc.Repaginate()
            doc.Fields.Update()
        doc.Repaginate()
        doc.Save()
        doc.ExportAsFixedFormat(
            OutputFileName=pdf_path,
            ExportFormat=17,  # wdExportFormatPDF
            OpenAfterExport=False,
            OptimizeFor=0,  # wdExportOptimizeForPrint
            Range=0,  # wdExportAllDocument
            Item=0,  # wdExportDocumentContent
            IncludeDocProps=True,
            KeepIRM=True,
            CreateBookmarks=0,  # wdExportCreateNoBookmarks
            DocStructureTags=True,
            BitmapMissingFonts=True,
            UseISO19005_1=False,
        )
        # Persist any field-cache refresh the PDF export triggered, mirroring
        # the macOS template's second DOCX save after "save as ... PDF".
        doc.Save()
        doc.Close(SaveChanges=0)  # wdDoNotSaveChanges
        print(f"Word process completed; Word {word.Version}")
    except Exception as exc:  # noqa: BLE001 - surface every COM failure to the parent
        try:
            if doc is not None:
                doc.Close(SaveChanges=0)
        except Exception:
            pass
        _fail(str(exc))
    finally:
        try:
            # Only our own instance is ever quit; refuse if anything else is
            # open in it (cannot happen for a DispatchEx instance, but stay safe).
            if word is not None and word.Documents.Count == 0:
                word.Quit()
        except Exception:
            pass
        pythoncom.CoUninitialize()


def run_excel(input_path: str, pdf_path: str) -> None:
    import pythoncom
    import win32com.client as win32

    pythoncom.CoInitialize()
    excel = None
    wb = None
    try:
        # Private instance for the same reason as run_word (audit C6).
        excel = win32.DispatchEx("Excel.Application")
        excel.Visible = False
        excel.DisplayAlerts = False
        wb = excel.Workbooks.Open(input_path)
        # Application-wide full recalculation, matching the macOS template's
        # app-scope "calculate" (not a single range/sheet).
        excel.CalculateFullRebuild()
        wb.Save()
        wb.ExportAsFixedFormat(0, pdf_path)  # 0 = xlTypePDF
        wb.Close(SaveChanges=False)
        print(f"Excel process completed; Excel {excel.Version}")
    except Exception as exc:  # noqa: BLE001
        try:
            if wb is not None:
                wb.Close(SaveChanges=False)
        except Exception:
            pass
        _fail(str(exc))
    finally:
        try:
            if excel is not None and excel.Workbooks.Count == 0:
                excel.Quit()
        except Exception:
            pass
        pythoncom.CoUninitialize()


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 10):
        print(
            json.dumps(
                {
                    "status": "blocked",
                    "reason": "Python 3.10 이상이 필요함 (현재 %d.%d). gg_deps.py python <폴더> 가 가리키는 인터프리터로 실행"
                    % sys.version_info[:2],
                },
                ensure_ascii=False,
            )
        )
        return 2
    argv = argv if argv is not None else sys.argv[1:]
    if sys.platform != "win32":
        _fail("gg_office_win.py는 Windows 전용입니다.", code=2)
    if len(argv) != 3:
        _fail("usage: gg_office_win.py <word|excel> <input_path> <pdf_out_path>", code=2)
    kind, input_path, pdf_path = argv
    if kind == "word":
        run_word(input_path, pdf_path)
    elif kind == "excel":
        run_excel(input_path, pdf_path)
    else:
        _fail(f"미지원 kind: {kind}", code=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
