"""audit C6: the Windows COM helper must never attach to (and then quit) the user's own Office session."""
import ast

from conftest import SCRIPTS


def test_office_win_uses_private_instances_and_conditional_quit():
    src = (SCRIPTS / "gg_office_win.py").read_text(encoding="utf-8")
    assert "gencache.EnsureDispatch(" not in src
    assert src.count('win32.DispatchEx("Word.Application")') == 1
    assert src.count('win32.DispatchEx("Excel.Application")') == 1
    assert "word.Documents.Count == 0" in src and "excel.Workbooks.Count == 0" in src
    ast.parse(src)  # still valid on this interpreter
