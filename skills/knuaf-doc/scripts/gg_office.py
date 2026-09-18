#!/usr/bin/env python3
"""Dedicated macOS/Windows Office conversion CLI.

Stages original DOCX/XLSX unchanged into a dedicated per-platform job
workspace (macOS: Office sandbox Group Container; Windows: local app-data
folder), drives Word field updates / Excel range recalculations and PDF
exports in the same automation session (macOS: bounded AppleScript via
osascript; Windows: bounded win32com COM calls run in a helper subprocess,
see gg_office_win.py), validates ZIP/PDF, and publishes to new destination
directories with overwrite protection. Only macOS and Windows are
implemented; other platforms fail closed with a clear error.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import shutil
import subprocess
import sys
import time
import uuid
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

def _default_workspace_dir() -> Path:
    """Returns the per-platform default staging workspace.

    macOS: real Office builds only accept AppleScript file access inside the
    app's sandbox Group Container, so staging must live there (see SKILL.md).
    Windows desktop Office is not sandboxed that way; COM automation can
    read/write any path the user has permission to, so a plain per-user
    local-app-data folder is used instead. Other platforms fall back to a
    dotfolder so --workspace override / doctor diagnostics stay usable
    without an import-time crash, even though word/excel automation itself
    is only implemented for macOS and Windows.
    """
    if sys.platform == "darwin":
        return (
            Path.home()
            / "Library"
            / "Group Containers"
            / "UBF8T346G9.Office"
            / "ginseng-goat"
        )
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "ginseng-goat" / "office-jobs"
    return Path.home() / ".ginseng-goat" / "office-jobs"


DEFAULT_GROUP_CONTAINER_DIR = _default_workspace_dir()

WORD_APPLESCRIPT_TEMPLATE = """
on run argv
    with timeout of {timeout} seconds
        tell application "Microsoft Word"
            try
                -- This Word build does not keep a stored document reference
                -- stable across field/update/save event boundaries.  The
                -- isolated job opens exactly one document, so use the
                -- dictionary's stable document-1 / active-document forms.
                -- A background or osascript-auto-launched Word accepts the
                -- open lock yet never registers the document (-1712 at the
                -- open boundary); the foreground-visible session is
                -- established by the Python preflight before this runs.
                open (POSIX file (item 1 of argv))
                repeat 2 times
                    repaginate document 1
                    -- On this build `every field of document 1` answers
                    -- neither `count` (so `repeat with` enumeration raises
                    -- -1708) nor the generic `update`; the dedicated
                    -- `update field` command accepts the plural specifier
                    -- directly and is a no-op on an empty collection.
                    update field (fields of document 1)
                end repeat
                repaginate document 1
                save document 1
                -- Word's dictionary declares the PDF target as `text`.
                -- Pass argv item 2 directly rather than coercing it through a
                -- POSIX-file alias: the latter returned zero on this Office
                -- build while creating no usable file at the requested path.
                -- Keep the direct target inside Word's application scope.  A
                -- stored document reference on this build can become
                -- unbound at the save-as command boundary (-2753), whereas
                -- the sole staged active document is stable here.
                save as active document file name (item 2 of argv) file format format PDF
                -- PDF pagination can refresh PAGEREF display caches after
                -- the first DOCX save. Persist them in the staged document
                -- before closing; otherwise the PDF is current but DOCX is not.
                save document 1
                close active document saving no
                return "Word process completed; Word " & version
            on error messageText number errorNumber
                try
                    close active document saving no
                end try
                error messageText number errorNumber
            end try
        end tell
    end timeout
end run
"""

EXCEL_APPLESCRIPT_TEMPLATE = """
on run argv
    with timeout of {timeout} seconds
        tell application "Microsoft Excel"
            try
                -- Excel's dictionary requires the named workbook-file
                -- argument here; passing a POSIX path directly returns -50
                -- on the supported macOS build.
                -- The staged copy is intentionally opened read-write; the
                -- original never enters the Excel session.
                open workbook workbook file name (item 1 of argv)
                -- Excel's AppleScript `calculate` command is application-wide
                -- in this dictionary, rather than range-addressable.
                calculate
                save active workbook
                -- Excel exposes PDF export through a sheet's named
                -- filename/file-format parameters.  On the supported build
                -- this exports the workbook's printable sheets; Python
                -- verifies the resulting PDF has at least one page per
                -- worksheet before publication.
                save as active sheet filename (item 2 of argv) file format PDF file format
                close active workbook saving no
                return "Excel process completed; Excel " & version
            on error messageText number errorNumber
                try
                    close active workbook saving no
                end try
                error messageText number errorNumber
            end try
        end tell
    end timeout
end run
"""


def compute_sha256(data: bytes) -> str:
    """Returns hexadecimal SHA-256 digest of bytes."""
    return hashlib.sha256(data).hexdigest()


OS_CANONICAL_SYMLINKS = {
    "/etc": "/private/etc",
    "/tmp": "/private/tmp",
    "/var": "/private/var",
}


def check_no_symlinks(path: Path) -> None:
    """Rejects path if the path itself or any parent component is a symbolic link.

    macOS exposes /etc, /tmp and /var as OS-level symlinks into /private; those
    canonical indirections are tolerated on Darwin only when the component is
    actually a symlink resolving to its canonical /private target — the name
    alone is never trusted. Any other symlink component — including ones
    planted below those prefixes — is still rejected.
    """
    p = path.absolute()
    curr = Path(p.root)
    for part in p.parts[1:]:
        curr = curr / part
        if not curr.is_symlink():
            continue
        canonical = OS_CANONICAL_SYMLINKS.get(str(curr))
        if (
            sys.platform == "darwin"
            and canonical is not None
            and os.path.realpath(curr) == canonical
        ):
            continue
        raise ValueError(f"심볼릭 링크 경로 거부: {curr}")


HYPERLINK_REL_TYPE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
)


def check_ooxml_relationships(zip_path: Path) -> None:
    """Validates that OOXML package contains no dangerous external path traversals or external resource links."""
    if not zip_path.is_file():
        raise ValueError(f"파일을 찾을 수 없습니다: {zip_path}")

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            bad_member = zf.testzip()
            if bad_member is not None:
                raise ValueError(f"손상된 ZIP 아카이브: {bad_member}")

            zip_names_set = set(zf.namelist())

            for name in zf.namelist():
                if name.endswith(".rels"):
                    # Determine the directory of the owning part
                    rels_dir = posixpath.dirname(name)
                    if rels_dir == "_rels" or rels_dir == "":
                        part_dir = ""
                    elif rels_dir.endswith("/_rels"):
                        part_dir = rels_dir[:-6]
                    else:
                        part_dir = posixpath.dirname(rels_dir)

                    try:
                        content = zf.read(name)
                        root = ET.fromstring(content)
                        for elem in root.findall(
                            "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"
                        ):
                            target_mode = elem.get("TargetMode", "")
                            target = elem.get("Target", "")
                            rel_type = elem.get("Type", "")

                            if target_mode == "External":
                                if rel_type == HYPERLINK_REL_TYPE:
                                    if (
                                        target.startswith("http://")
                                        or target.startswith("https://")
                                        or target.startswith("mailto:")
                                    ):
                                        continue
                                    raise ValueError(
                                        f"위험한 외부 하이퍼링크 거부: {target} (in {name})"
                                    )
                                raise ValueError(
                                    f"위험한 외부 OOXML 관계 참조 거부 (타입: {rel_type}, 대상: {target}, 위치: {name})"
                                )
                            else:
                                if target.startswith("file:"):
                                    raise ValueError(
                                        f"위험한 내부 OOXML 관계 file scheme 거부: {target} (in {name})"
                                    )

                                clean_target = urllib.parse.unquote(
                                    target.split("#")[0].split("?")[0]
                                )
                                if not clean_target:
                                    continue

                                if clean_target.startswith("/"):
                                    norm_path = posixpath.normpath(
                                        clean_target.lstrip("/")
                                    )
                                else:
                                    norm_path = posixpath.normpath(
                                        posixpath.join(part_dir, clean_target)
                                    )

                                if (
                                    norm_path.startswith("../")
                                    or norm_path == ".."
                                ):
                                    raise ValueError(
                                        f"위험한 내부 OOXML 관계 패키지 루트 이탈 거부: {target} (in {name})"
                                    )

                                if (
                                    norm_path not in zip_names_set
                                    and norm_path != "."
                                    and norm_path != ""
                                ):
                                    raise ValueError(
                                        f"존재하지 않는 내부 OOXML 파트 참조: {target} (정규화: {norm_path}, 위치: {name})"
                                    )
                    except ET.ParseError as e:
                        raise ValueError(f"잘못된 OOXML 관계 XML ({name}): {e}")
    except (zipfile.BadZipFile, zipfile.LargeZipFile) as e:
        raise ValueError(f"유효한 OOXML ZIP 파일이 아닙니다: {e}")

def stage_resources(
    resource_paths: list[str | Path],
    base_dir: Path,
    staged_target_dirs: list[Path],
) -> list[str]:
    """Copies resource files into staging targets preserving safe relative paths, rejecting symlinks and traversals."""
    copied = []
    base_resolved = base_dir.resolve()

    for r_path in resource_paths:
        p = Path(r_path)
        source_path = p if p.is_absolute() else (base_dir / p)

        check_no_symlinks(source_path)

        resolved_source = source_path.resolve()
        if not resolved_source.is_file():
            raise ValueError(f"리소스 파일이 존재하지 않습니다: {source_path}")

        try:
            rel = resolved_source.relative_to(base_resolved)
        except ValueError:
            raise ValueError(f"기준 디렉터리 외부 리소스 거부: {source_path}")

        if ".." in str(rel) or rel.is_absolute():
            raise ValueError(f"경로 탐색 리소스 거부: {r_path}")

        for target_dir in staged_target_dirs:
            dest_file = target_dir / rel
            if dest_file.is_symlink():
                raise ValueError(f"심볼릭 링크 대상 거부: {dest_file}")
            dest_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(resolved_source, dest_file)

        copied.append(str(rel))

    return copied


def stage_job(
    input_file: Path,
    workspace_root: Path,
    resources: list[str | Path] | None = None,
) -> tuple[Path, Path, Path, Path, str]:
    """Sets up a unique job directory under workspace and stages copies of input and resources.

    Returns:
        job_dir, staged_input_file, staged_working_file, staged_pdf_file, orig_sha256
    """
    input_path = Path(input_file)
    check_no_symlinks(input_path)

    input_resolved = input_path.resolve()
    if not input_resolved.is_file():
        raise ValueError(f"입력 파일이 존재하지 않습니다: {input_path}")

    check_ooxml_relationships(input_resolved)

    orig_sha256 = compute_sha256(input_resolved.read_bytes())

    run_id = f"job-{uuid.uuid4().hex[:12]}-{int(time.time())}"
    job_dir = workspace_root / run_id
    staged_input_dir = job_dir / "input"
    staged_output_dir = job_dir / "output"

    staged_input_dir.mkdir(parents=True, exist_ok=True)
    staged_output_dir.mkdir(parents=True, exist_ok=True)

    staged_input_file = staged_input_dir / input_resolved.name
    shutil.copy2(input_resolved, staged_input_file)

    staged_working_file = staged_output_dir / input_resolved.name
    shutil.copy2(input_resolved, staged_working_file)

    staged_pdf_file = staged_output_dir / (input_resolved.stem + ".pdf")

    if resources:
        stage_resources(
            resources,
            input_resolved.parent,
            [staged_input_dir, staged_output_dir],
        )

    return job_dir, staged_input_file, staged_working_file, staged_pdf_file, orig_sha256


WORD_READY_APPLESCRIPT = 'tell application "Microsoft Word" to return name'


def ensure_word_foreground_session(timeout: int = 30) -> None:
    """Bring Word up foreground-visible and bound-confirm it answers.

    On this Word 16.112.4 build, `open` on a field-bearing document only
    completes when Word has a real foreground UI session: an instance that
    was osascript-auto-launched or `open -g` background-launched accepts the
    file lock yet never registers the document, and the script dies at the
    open boundary (-1712).  Reproduce the proven-good launch shape —
    `open -a` launches or foregrounds the app — then bound the readiness
    probe so a Word that never comes up fails closed instead of burning
    the document timeout.
    """
    subprocess.run(
        ["open", "-a", "Microsoft Word"],
        check=False, capture_output=True, timeout=15,
    )
    deadline = time.monotonic() + timeout
    while True:
        try:
            res = run_osascript(WORD_READY_APPLESCRIPT, [], timeout=5)
            if res.returncode == 0:
                return
        except TimeoutError:
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Microsoft Word 실행 준비 시간 초과 ({timeout}초)")
        time.sleep(0.5)


def run_osascript(script: str, args: list[str], timeout: int = 90) -> subprocess.CompletedProcess:
    """Executes osascript with bounded timeout."""
    cmd = ["osascript", "-e", script] + [str(a) for a in args]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return res
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"Office osascript 실행 시간 초과 ({timeout}초)") from exc


def format_osascript_error(res: subprocess.CompletedProcess, app_name: str) -> str:
    """Extracts structured diagnostic message from osascript failure."""
    err_text = (res.stderr or "").strip()
    out_text = (res.stdout or "").strip()
    combined = f"{err_text} {out_text}".strip()

    if "-1743" in combined or "Not authorized to send Apple events" in combined:
        return (
            f"[{app_name} 권한 오류: -1743] macOS '시스템 설정 > 개인정보 보호 및 보안 > 자동화(Automation)'에서 "
            f"실행 터미널/환경에 {app_name} 제어 권한을 허용해야 합니다. (기존 원본 파일 보존됨)"
        )
    if "-1712" in combined or "AppleEvent timed out" in combined:
        return (
            f"[{app_name} 시간 초과: -1712] {app_name} 응답 대기 시간 초과. 대화상자가 열려 있거나 응답하지 않습니다."
        )
    if "-10004" in combined or "User canceled" in combined:
        return f"[{app_name} 사용자 취소: -10004] 작업이 취소되었습니다."

    return f"[{app_name} 실행 실패 (코드 {res.returncode})] {err_text or out_text or '알 수 없는 오류'}"


def _windows_com_app_registered(prog_id: str) -> bool:
    """Checks the Windows registry for a registered COM ProgID.

    Returns False on any non-Windows platform without importing winreg
    (stdlib module that only exists on Windows).
    """
    if sys.platform != "win32":
        return False
    import winreg

    try:
        winreg.QueryValue(winreg.HKEY_CLASSES_ROOT, f"{prog_id}\\CLSID")
        return True
    except OSError:
        return False


def run_windows_com(kind: str, args: list[str], timeout: int = 90) -> subprocess.CompletedProcess:
    """Executes the Windows COM automation helper (gg_office_win.py) as a
    bounded-timeout subprocess.

    Runs the actual win32com Word/Excel calls in a separate process rather
    than in-process, so a hung COM session cannot block this CLI past
    timeout the same way subprocess.run(..., timeout=...) already bounds
    run_osascript on macOS. gg_office_win.py is Windows-only and is not
    imported here directly; it is only ever invoked as argv[0]=sys.executable.
    """
    helper = Path(__file__).with_name("gg_office_win.py")
    if not helper.is_file():
        raise ValueError(f"Windows COM 헬퍼 스크립트 누락: {helper}")
    cmd = [sys.executable, str(helper), kind] + [str(a) for a in args]
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return res
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"Office Windows COM 실행 시간 초과 ({timeout}초)") from exc


def format_windows_error(res: subprocess.CompletedProcess, app_name: str) -> str:
    """Extracts a structured diagnostic message from a Windows COM automation failure."""
    err_text = (res.stderr or "").strip()
    out_text = (res.stdout or "").strip()
    combined = f"{err_text} {out_text}".strip()

    if (
        "-2147221005" in combined
        or "Invalid class string" in combined
        or "잘못된 클래스 문자열" in combined
    ):
        return (
            f"[{app_name} COM 등록 오류] {app_name}이(가) 설치돼 있지 않거나 COM에 등록되지 않았습니다. "
            f"Microsoft {app_name} 설치를 확인하세요."
        )
    if "com_error" in combined or "-2147023170" in combined:
        return f"[{app_name} 통신 오류] COM 서버(RPC)와 통신할 수 없습니다. {app_name}을(를) 재시작 후 다시 시도하세요."
    if "PermissionError" in combined or "액세스가 거부" in combined or "Access is denied" in combined:
        return f"[{app_name} 권한 오류] 파일 접근이 거부되었습니다. 다른 프로그램에서 파일을 열고 있는지 확인하세요."

    return f"[{app_name} 실행 실패 (코드 {res.returncode})] {err_text or out_text or '알 수 없는 오류'}"


def format_engine_error(res: subprocess.CompletedProcess, app_name: str) -> str:
    """Dispatches to the platform-appropriate automation-engine error formatter."""
    if sys.platform == "win32":
        return format_windows_error(res, app_name)
    return format_osascript_error(res, app_name)


def run_word_engine(
    staged_work: Path, staged_pdf: Path, timeout: int = 90
) -> subprocess.CompletedProcess:
    """Dispatches Word field-update/repagination/PDF-export to the platform engine."""
    if sys.platform == "darwin":
        ensure_word_foreground_session()
        return run_osascript(
            WORD_APPLESCRIPT_TEMPLATE.format(timeout=timeout),
            [str(staged_work), str(staged_pdf)],
            timeout=timeout,
        )
    if sys.platform == "win32":
        return run_windows_com("word", [str(staged_work), str(staged_pdf)], timeout=timeout)
    raise ValueError(f"미지원 플랫폼: {sys.platform} (Word 자동화는 macOS/Windows만 지원)")


def run_excel_engine(
    staged_work: Path, staged_pdf: Path, timeout: int = 90
) -> subprocess.CompletedProcess:
    """Dispatches Excel recalculation/PDF-export to the platform engine."""
    if sys.platform == "darwin":
        return run_osascript(
            EXCEL_APPLESCRIPT_TEMPLATE.format(timeout=timeout),
            [str(staged_work), str(staged_pdf)],
            timeout=timeout,
        )
    if sys.platform == "win32":
        return run_windows_com("excel", [str(staged_work), str(staged_pdf)], timeout=timeout)
    raise ValueError(f"미지원 플랫폼: {sys.platform} (Excel 자동화는 macOS/Windows만 지원)")


def validate_office_file(path: Path, expected_kind: str) -> dict:
    """Validates that output DOCX/XLSX is readable and structurally sound."""
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"출력 Office 파일이 생성되지 않았거나 비어 있습니다: {path}")

    try:
        with zipfile.ZipFile(path, "r") as zf:
            bad = zf.testzip()
            if bad is not None:
                raise ValueError(f"출력 Office ZIP 손상 ({bad}): {path}")
            names = zf.namelist()
            if expected_kind in ("word", "docx"):
                if "word/document.xml" not in names:
                    raise ValueError("DOCX 필수 XML(word/document.xml) 누락")
            elif expected_kind in ("excel", "xlsx"):
                if "xl/workbook.xml" not in names:
                    raise ValueError("XLSX 필수 XML(xl/workbook.xml) 누락")
    except (zipfile.BadZipFile, zipfile.LargeZipFile) as e:
        raise ValueError(f"출력 Office ZIP 손상: {e}")

    # Re-screen relationships on the app-rewritten output before publication
    check_ooxml_relationships(path)

    return {
        "valid": True,
        "size_bytes": path.stat().st_size,
        "sha256": compute_sha256(path.read_bytes()),
    }


def validate_pdf_file(path: Path) -> dict:
    """Validates that exported PDF is non-empty and structurally valid using pypdf."""
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"출력 PDF 파일이 생성되지 않았거나 비어 있습니다: {path}")

    raw = path.read_bytes()
    if not raw.startswith(b"%PDF-"):
        raise ValueError("PDF 파일 매직 넘버(%PDF-) 누락")

    if not importlib.util.find_spec("pypdf"):
        raise RuntimeError("PDF 검증을 위해 pypdf 패키지가 필수입니다.")

    import pypdf

    try:
        reader = pypdf.PdfReader(str(path))
        pages = len(reader.pages)
        if pages == 0:
            raise ValueError("PDF 페이지 수가 0입니다")
    except Exception as e:
        raise ValueError(f"pypdf 검증 실패: {e}")

    return {
        "valid": True,
        "size_bytes": len(raw),
        "pages": pages,
        "sha256": compute_sha256(raw),
    }


def workbook_worksheet_count(path: Path) -> int:
    """Counts XLSX worksheet declarations without reinterpreting cell data."""
    with zipfile.ZipFile(path, "r") as zf:
        root = ET.fromstring(zf.read("xl/workbook.xml"))
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    count = len(root.findall("x:sheets/x:sheet", ns))
    if count < 1:
        raise ValueError("Excel workbook contains no worksheets")
    return count


def publish_outputs(
    staged_working_file: Path,
    staged_pdf_file: Path,
    out_dir: Path,
    input_file: Path,
    orig_sha256: str,
    job_dir: Path,
    engine_name: str,
    engine_result: str,
    expected_kind: str = "word",
    engine_stderr: str = "",
    extra_validation: dict | None = None,
) -> dict:
    """Publishes validated staged files to new destination directory without overwriting."""
    # Validate staged files BEFORE creating output directory
    office_meta = validate_office_file(staged_working_file, expected_kind)
    pdf_meta = validate_pdf_file(staged_pdf_file)

    # Verify original file integrity
    current_input_sha = compute_sha256(input_file.read_bytes())
    if current_input_sha != orig_sha256:
        raise RuntimeError("작업 중 원본 파일 변경 감지됨")

    staged_work_bytes = staged_working_file.read_bytes()
    staged_pdf_bytes = staged_pdf_file.read_bytes()
    staged_work_sha = compute_sha256(staged_work_bytes)
    staged_pdf_sha = compute_sha256(staged_pdf_bytes)

    out_dir = Path(out_dir).resolve()
    try:
        out_dir.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        raise FileExistsError(f"기존 출력 디렉터리 덮어쓰기 금지 (새 디렉터리 필요): {out_dir}")

    dest_office = out_dir / input_file.name
    dest_pdf = out_dir / (input_file.stem + ".pdf")
    dest_manifest = out_dir / (input_file.stem + ".office.manifest.json")

    created_paths = []
    try:
        # Exclusive atomic creation with 'xb'
        with open(dest_office, "xb") as f:
            created_paths.append(dest_office)
            f.write(staged_work_bytes)
        with open(dest_pdf, "xb") as f:
            created_paths.append(dest_pdf)
            f.write(staged_pdf_bytes)

        # Post-publish hash verification
        if compute_sha256(dest_office.read_bytes()) != staged_work_sha:
            raise RuntimeError("발행된 Office 파일 해시 불일치")
        if compute_sha256(dest_pdf.read_bytes()) != staged_pdf_sha:
            raise RuntimeError("발행된 PDF 파일 해시 불일치")

        val_data = dict(extra_validation or {})
        val_data[expected_kind] = office_meta
        val_data["pdf"] = pdf_meta

        receipt = {
            "status": "converted",
            "engine": engine_name,
            "engine_result": engine_result.strip(),
            "engine_stderr": engine_stderr.strip(),
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_working_file),
            "staged_pdf_file": str(staged_pdf_file),
            "input_file": str(input_file.resolve()),
            "input_sha256": orig_sha256,
            "published_office": str(dest_office),
            "published_office_sha256": staged_work_sha,
            "published_pdf": str(dest_pdf),
            "published_pdf_sha256": staged_pdf_sha,
            "timestamp_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "validation": val_data,
        }

        manifest_bytes = json.dumps(receipt, ensure_ascii=False, indent=2).encode("utf-8")
        with open(dest_manifest, "xb") as f:
            created_paths.append(dest_manifest)
            f.write(manifest_bytes)
        return receipt
    except Exception:
        # Only remove files this call created. Do not remove unrelated files
        # another process may have added after the exclusive directory create.
        for created in reversed(created_paths):
            try:
                created.unlink()
            except OSError:
                pass
        try:
            out_dir.rmdir()
        except OSError:
            pass
        raise



def process_word(
    input_file: str | Path,
    out_dir: str | Path,
    resources: list[str | Path] | None = None,
    timeout: int = 90,
    workspace: str | Path | None = None,
) -> dict:
    """Processes Word document: repaginates, updates indexed fields, saves DOCX and exports PDF."""
    input_path = Path(input_file).absolute()
    out_path = Path(out_dir).absolute()
    ws_root = Path(workspace).resolve() if workspace else DEFAULT_GROUP_CONTAINER_DIR

    job_dir, staged_in, staged_work, staged_pdf, orig_sha = stage_job(
        input_path, ws_root, resources
    )

    try:
        res = run_word_engine(staged_work, staged_pdf, timeout=timeout)
    except TimeoutError as exc:
        fail_receipt = {
            "status": "fail",
            "app": "Word",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "error": f"[Microsoft Word 시간 초과: -1712] {exc}",
            "engine_stderr": str(exc),
            "returncode": -1712,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    if res.returncode != 0:
        err_msg = format_engine_error(res, "Microsoft Word")
        fail_receipt = {
            "status": "fail",
            "app": "Word",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "error": err_msg,
            "engine_stderr": (res.stderr or "").strip(),
            "returncode": res.returncode,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    try:
        return publish_outputs(
            staged_working_file=staged_work,
            staged_pdf_file=staged_pdf,
            out_dir=out_path,
            input_file=input_path,
            orig_sha256=orig_sha,
            job_dir=job_dir,
            engine_name="Microsoft Word",
            engine_result=res.stdout or "Word completed",
            expected_kind="word",
            engine_stderr=res.stderr or "",
        )
    except Exception as exc:
        # Word's AppleScript save-as can return zero without creating the PDF.
        # Preserve the staged DOCX and make that false-positive a durable,
        # fail-closed receipt rather than allowing a caller to infer success.
        fail_receipt = {
            "status": "fail",
            "app": "Word",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "staged_pdf_file": str(staged_pdf),
            "error": f"[Microsoft Word 출력 검증 실패] {exc}",
            "engine_stderr": (res.stderr or "").strip(),
            "returncode": res.returncode,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

def template_receipt_binding(input_path, receipt_path):
    """Bind a completed template operation; this is not content approval."""
    path = Path(receipt_path).resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    schema = data.get("schema")
    if schema == "gg-xlsx-fill-receipt/v1":
        if (
            data.get("output", {}).get("status") != "filled"
            or not isinstance(data.get("written"), list)
            or not data["written"]
        ):
            raise ValueError("template receipt must record a completed fill operation")
        input_parts = ("template", "map", "values")
    elif schema == "gg-xlsx-formula-patch-receipt/v1":
        if (
            data.get("output", {}).get("status") != "patched"
            or not isinstance(data.get("patched"), list)
            or not data["patched"]
        ):
            raise ValueError("template receipt must record a completed formula patch")
        input_parts = ("source", "map")
    elif schema == "gg-xlsx-print-receipt/v1":
        if not isinstance(data.get("changes"), list) or not data["changes"]:
            raise ValueError("template receipt must record completed print changes")
        input_parts = ("source", "map")
    else:
        raise ValueError("unsupported template operation receipt schema")
    import re
    for part in input_parts:
        if not re.fullmatch(r"[0-9a-f]{64}", str(data.get(part, {}).get("sha256", ""))):
            raise ValueError("template receipt missing input hash: " + part)
        if "path" in data[part]:
            declared = data[part]["path"]
            if not isinstance(declared, str) or not declared.strip():
                raise ValueError("template receipt invalid input path: " + part)
            # Product-written receipts record resolved absolute paths, and the
            # source artifact commonly lives outside the receipt folder: an
            # absolute path is bound by existence + hash only. Only a relative
            # path may not escape the receipt folder.
            declared_path = Path(declared)
            if declared_path.is_absolute():
                source_path = declared_path.resolve()
            else:
                source_path = (path.parent / declared_path).resolve()
                if not source_path.is_relative_to(path.parent):
                    raise ValueError("template receipt input path escapes receipt folder: " + part)
            if not source_path.is_file():
                raise ValueError("template receipt input path not found: " + part)
            if compute_sha256(source_path.read_bytes()) != data[part]["sha256"]:
                raise ValueError("template receipt input hash mismatch: " + part)
    actual = compute_sha256(Path(input_path).read_bytes())
    if data.get("output", {}).get("sha256") != actual:
        raise ValueError("template receipt output hash does not match input workbook")
    return {"path": str(path), "sha256": compute_sha256(path.read_bytes()),
            "input_sha256": actual, "authority": "operation_receipt_only"}


def verify_template_lineage(input_file, receipt_paths):
    """Verify local operation ancestry, never financial or human approval."""
    if not receipt_paths:
        raise ValueError("template lineage requires receipts")

    def artifact_hash(record, parent):
        if not isinstance(record, dict):
            raise ValueError("lineage artifact record required")
        name = record.get("path")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("lineage artifact path required")
        # Same rule as template_receipt_binding: absolute paths (what the
        # product writes) bind by existence + hash; only relative paths are
        # confined to the receipt folder.
        declared_path = Path(name)
        if declared_path.is_absolute():
            artifact = declared_path.resolve()
        else:
            artifact = (parent / declared_path).resolve()
            if not artifact.is_relative_to(parent):
                raise ValueError("lineage artifact path escapes receipt folder")
        if not artifact.is_file():
            raise ValueError("lineage artifact path not found")
        actual = compute_sha256(artifact.read_bytes())
        if actual != record.get("sha256"):
            raise ValueError("lineage artifact hash mismatch")
        return actual

    operations = {
        "gg-xlsx-fill-receipt/v1": ("template", "map", "values"),
        "gg-xlsx-print-receipt/v1": ("source", "map"),
        "gg-xlsx-formula-patch-receipt/v1": ("source", "map"),
    }
    rows = []
    seen = set()
    previous_output = None
    previous_receipt = None
    for receipt_path in receipt_paths:
        path = Path(receipt_path).resolve()
        if path in seen:
            raise ValueError("duplicate receipt in template lineage")
        seen.add(path)
        raw = path.read_bytes()
        data = json.loads(raw)
        schema = data.get("schema")
        if not rows and schema not in {
            "gg-xlsx-template-receipt/v1", "gg-xlsx-fill-receipt/v1",
        }:
            raise ValueError("template lineage must start with clear or fill")
        if schema == "gg-xlsx-template-receipt/v1":
            if rows or data.get("output", {}).get("status") not in {
                "partial", "blank_template",
            } or not isinstance(data.get("cleared"), list):
                raise ValueError("invalid template clear operation")
            source_hash = artifact_hash(data.get("source"), path.parent)
            output_hash = artifact_hash(data.get("output"), path.parent)
            operation_status = data["output"]["status"]
        elif schema in operations:
            for part in operations[schema]:
                artifact_hash(data.get(part), path.parent)
            output_hash = artifact_hash(data.get("output"), path.parent)
            template_receipt_binding(path.parent / data["output"]["path"], path)
            source_hash = data[operations[schema][0]]["sha256"]
            operation_status = data["output"].get("status", "layout_copy_created")
        elif data.get("status") == "converted" and data.get("engine") == "Microsoft Excel":
            validation = data.get("validation", {})
            if (
                validation.get("structure_issues") != []
                or validation.get("template_receipt", {}).get("sha256") != previous_receipt
            ):
                raise ValueError("native receipt does not bind the preceding operation")
            source_hash = data.get("input_sha256")
            output_hash = artifact_hash({
                "path": data.get("published_office"),
                "sha256": data.get("published_office_sha256"),
            }, path.parent)
            artifact_hash({
                "path": data.get("published_pdf"),
                "sha256": data.get("published_pdf_sha256"),
            }, path.parent)
            operation_status = "converted"
            schema = "native_excel"
        else:
            raise ValueError("unsupported template lineage receipt")
        if previous_output is not None and source_hash != previous_output:
            raise ValueError("template lineage input does not match preceding output")
        previous_output = output_hash
        previous_receipt = compute_sha256(raw)
        rows.append({
            "path": str(path), "sha256": previous_receipt, "schema": schema,
            "operation_status": operation_status, "output_sha256": output_hash,
        })
    if compute_sha256(Path(input_file).read_bytes()) != previous_output:
        raise ValueError("template lineage does not reach the current workbook")
    return {
        "status": "pass", "authority": "operation_lineage_only",
        "output_sha256": previous_output, "receipts": rows,
    }


def inspect_preserved_template(before, after):
    """Compare this source layout with its native save, not a generated layout."""
    from decimal import Decimal
    from gg_excel_template import workbook_sheets, load_shared, text_value, NS_MAIN
    from openpyxl.styles.numbers import BUILTIN_FORMATS
    from openpyxl.formula.translate import Translator

    # Read original style indexes directly: openpyxl skips MC AlternateContent
    # style entries and therefore shifts subsequent indexes in some supplied
    # workbooks. Resolve their fallback without resaving the source.
    def snapshot(path):
        tag = "{" + NS_MAIN + "}"
        with zipfile.ZipFile(path) as archive:
            shared = load_shared(archive)
            book = ET.fromstring(archive.read("xl/workbook.xml"))
            sheet_meta = {x.get("name"): x.get("state", "visible")
                          for x in book.findall(tag + "sheets/" + tag + "sheet")}
            names = [(x.get("name"), x.get("localSheetId"), x.text or "")
                     for x in book.findall(tag + "definedNames/" + tag + "definedName")
                     if x.get("name") in ("_xlnm.Print_Area", "_xlnm.Print_Titles")]
            styles = ET.fromstring(archive.read("xl/styles.xml"))
            formats = dict(BUILTIN_FORMATS)
            for item in styles.findall(tag + "numFmts/" + tag + "numFmt"):
                formats[int(item.get("numFmtId"))] = item.get("formatCode")
            mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
            xfs = []
            for item in styles.find(tag + "cellXfs"):
                xf = item if item.tag == tag + "xf" else item.find(mc + "Fallback/" + tag + "xf")
                if xf is None:
                    raise ValueError("unsupported style alternative without an xf fallback")
                xfs.append(xf)
            ordered = workbook_sheets(archive)
            result = {"sheet_order": [x[0] for x in ordered], "sheets": {}}
            for index, (name, part) in enumerate(ordered):
                root = ET.fromstring(archive.read(part)); cells = {}
                shared_formulas = {}
                for cell in root.iter(tag + "c"):
                    formula = cell.find(tag + "f")
                    if formula is not None and formula.get("t") == "shared" and formula.text:
                        shared_formulas[formula.get("si")] = (cell.get("r"), formula.text)
                for cell in root.iter(tag + "c"):
                    ref = cell.get("r"); formula = cell.find(tag + "f")
                    value = text_value(cell, shared)
                    kind = cell.get("t", "n")
                    if formula is not None:
                        if formula.get("t") == "shared":
                            anchor, expression = shared_formulas[formula.get("si")]
                            expression = Translator("=" + expression, origin=anchor).translate_formula(ref)[1:]
                            attributes = ()
                        else:
                            expression = formula.text or ""
                            attributes = tuple(sorted((k, v) for k, v in formula.attrib.items() if k in ("t", "ref") and v != "normal"))
                        value = (expression, attributes)
                        kind = "formula"
                    elif value in (None, ""):
                        continue
                    elif kind in ("s", "inlineStr", "str"):
                        kind = "string"
                    elif kind in ("n", "b"):
                        value = Decimal(str(value))
                    style = int(cell.get("s", "0"))
                    if style >= len(xfs):
                        raise ValueError(f"invalid source style index: {name}!{ref}")
                    fmt_id = int(xfs[style].get("numFmtId", "0"))
                    cells[ref] = (kind, value, formats.get(fmt_id, f"builtin:{fmt_id}"))
                result["sheets"][name] = {
                    "state": sheet_meta[name],
                    "merges": sorted(x.get("ref") for x in root.findall(tag + "mergeCells/" + tag + "mergeCell")),
                    # Excel rewrites quoted non-ASCII sheet references (for
                    # example, '목록'!$B$2:$J$36) without changing the
                    # defined range.  Compare the reference semantically so
                    # that this harmless native canonicalization cannot mask
                    # the actual cell/merge/formula preservation checks.
                    "print_area": sorted(
                        (n, value.replace("''", "\0").replace("'", "").replace("\0", "'"))
                        for n, idx, value in names if idx == str(index)
                    ),
                    "cells": cells,
                }
            return result

    left, right = snapshot(before), snapshot(after)
    issues = []
    if left["sheet_order"] != right["sheet_order"]:
        issues.append({"status": "fail", "reason": "template sheet order changed"})
    for name, original in left["sheets"].items():
        saved = right["sheets"].get(name)
        if saved is None:
            issues.append({"status": "fail", "reason": "template sheet missing", "sheet": name})
            continue
        for key in ("state", "merges", "print_area"):
            if original[key] != saved[key]:
                issues.append({"status": "fail", "reason": "template " + key + " changed", "sheet": name})
        for cell in sorted(set(original["cells"]) | set(saved["cells"])):
            old = original["cells"].get(cell)
            new = saved["cells"].get(cell)
            if old is None or new is None or old[:2] != new[:2]:
                issues.append({"status": "fail", "reason": "template formula/value changed",
                               "sheet": name, "cell": cell})
            elif old[2] != new[2]:
                issues.append({"status": "needs_visual_review", "reason": "native number format changed",
                               "sheet": name, "cell": cell, "before": old[2], "after": new[2]})
    return issues


def process_excel(
    input_file: str | Path,
    out_dir: str | Path,
    resources: list[str | Path] | None = None,
    spec_file: str | Path | None = None,
    timeout: int = 90,
    workspace: str | Path | None = None,
    template_receipt: str | Path | None = None,
) -> dict:
    """Processes Excel workbook: calculates all used ranges, saves XLSX and exports PDF in same session."""
    input_path = Path(input_file).absolute()
    out_path = Path(out_dir).absolute()
    ws_root = Path(workspace).resolve() if workspace else DEFAULT_GROUP_CONTAINER_DIR

    if spec_file:
        spec_path = Path(spec_file).absolute()
        if not spec_path.is_file():
            raise ValueError(f"지정된 spec 파일이 존재하지 않습니다: {spec_file}")

    binding = None
    if template_receipt:
        if spec_file:
            raise ValueError("template receipt and generated-workbook spec cannot be combined")
        binding = template_receipt_binding(input_path, template_receipt)

    job_dir, staged_in, staged_work, staged_pdf, orig_sha = stage_job(
        input_path, ws_root, resources
    )

    try:
        res = run_excel_engine(staged_work, staged_pdf, timeout=timeout)
    except TimeoutError as exc:
        fail_receipt = {
            "status": "fail",
            "app": "Excel",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "error": f"[Microsoft Excel 시간 초과: -1712] {exc}",
            "engine_stderr": str(exc),
            "returncode": -1712,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    if res.returncode != 0:
        err_msg = format_engine_error(res, "Microsoft Excel")
        fail_receipt = {
            "status": "fail",
            "app": "Excel",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "error": err_msg,
            "engine_stderr": (res.stderr or "").strip(),
            "returncode": res.returncode,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    try:
        pdf_coverage = validate_pdf_file(staged_pdf)
        worksheet_count = workbook_worksheet_count(staged_work)
        if pdf_coverage["pages"] < worksheet_count:
            raise ValueError(
                f"Excel PDF page coverage mismatch: worksheets={worksheet_count}, pdf_pages={pdf_coverage['pages']}"
            )
    except Exception as exc:
        fail_receipt = {
            "status": "fail",
            "app": "Excel",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "staged_working_file": str(staged_work),
            "staged_pdf_file": str(staged_pdf),
            "error": f"[Microsoft Excel PDF 출력 검증 실패] {exc}",
            "engine_stderr": (res.stderr or "").strip(),
            "returncode": res.returncode,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    # A supplied template and the legacy generated workbook share sheet names
    # but have different cell/formula contracts. Never infer interchangeability.
    structure_issues = []
    school_validation_status = "not_applicable"
    template_format_changes = []
    if binding:
        school_validation_status = "source_template_preservation_only"
        try:
            compared = inspect_preserved_template(staged_in, staged_work)
            structure_issues = [x for x in compared if x["status"] == "fail"]
            template_format_changes = [x for x in compared if x["status"] != "fail"]
        except Exception as exc:
            structure_issues = [{"status": "fail", "reason": f"template comparison failed: {exc}"}]
    else:
        try:
            from openpyxl import load_workbook
            from gg_school_excel import SCHOOL_SHEETS, inspect_school_workbook

            wb_temp = load_workbook(staged_work, read_only=True)
            sheetnames_set = set(wb_temp.sheetnames)

            is_school_spec = False
            if spec_file:
                try:
                    spec_preview = json.loads(Path(spec_file).read_text())
                    if spec_preview.get("profile") == "school_17_sheet_v1":
                        is_school_spec = True
                except Exception:
                    pass

            has_school_sheets = bool(sheetnames_set & set(SCHOOL_SHEETS))

            if is_school_spec or has_school_sheets:
                school_validation_status = "evaluated"
                structure_issues = inspect_school_workbook(staged_work)
            else:
                school_validation_status = "not_applicable"
        except Exception as e:
            structure_issues = [{"status": "fail", "reason": f"구조 검사 실행 실패: {e}"}]
    if structure_issues:
        fail_receipt = {
            "status": "fail",
            "app": "Excel",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "error": "엑셀 구조 검사 실패",
            "structure_issues": structure_issues,
            "school_validation": school_validation_status,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    school_issues = []
    if spec_file:
        spec_p = Path(spec_file).resolve()
        try:
            spec_data = json.loads(spec_p.read_text())
            profile = spec_data.get("profile", "")
            if profile == "school_17_sheet_v1":
                from gg_school_verify import verify_school_recalculated

                school_issues = verify_school_recalculated(spec_data, staged_work)
            else:
                from gg_finance import verify_recalculated

                school_issues = verify_recalculated(spec_data, staged_work)
        except Exception as e:
            school_issues = [{"status": "fail", "reason": f"학교 검증기 실행 오류: {e}"}]

    if school_issues:
        fail_receipt = {
            "status": "fail",
            "app": "Excel",
            "input_file": str(input_path),
            "input_sha256": orig_sha,
            "job_dir": str(job_dir),
            "error": "학교 재무 검증 실패",
            "school_issues": school_issues,
            "school_validation": school_validation_status,
        }
        (job_dir / "failure_receipt.json").write_text(
            json.dumps(fail_receipt, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return fail_receipt

    extra_val = {
        "structure_issues": structure_issues,
        "school_issues": school_issues,
        "school_validation": school_validation_status,
        "template_receipt": binding,
        "financial_content_validation": "not_run" if binding else "see_school_issues_and_spec",
        "preservation_scope": ["sheet_order", "sheet_visibility", "merged_ranges", "print_ranges", "formulas", "nonblank_values"] if binding else None,
        "template_format_changes": template_format_changes,
        "number_format_validation": "changes_reported_for_visual_review" if binding else None,
        "visual_layout_validation": "separate_render_review_required",
        "native_pdf_coverage": {
            "worksheet_count": worksheet_count,
            "pdf_pages": pdf_coverage["pages"],
            "status": "page_count_floor_met",
        },
    }
    receipt = publish_outputs(
        staged_working_file=staged_work,
        staged_pdf_file=staged_pdf,
        out_dir=out_path,
        input_file=input_path,
        orig_sha256=orig_sha,
        job_dir=job_dir,
        engine_name="Microsoft Excel",
        engine_result=res.stdout or "Excel completed",
        expected_kind="excel",
        engine_stderr=res.stderr or "",
        extra_validation=extra_val,
    )
    return receipt


def process_batch(
    files: list[str | Path],
    out_dir: str | Path,
    timeout: int = 90,
    workspace: str | Path | None = None,
) -> dict:
    """Processes multiple Word/Excel files consecutively without UI clicks, stopping at first permission/timeout per app."""
    results = []
    failed_apps = set()
    permission_instructions = []

    for f in files:
        p = Path(f).absolute()
        ext = p.suffix.lower()
        app = "Word" if ext == ".docx" else ("Excel" if ext == ".xlsx" else "Unknown")

        if app in failed_apps:
            results.append({
                "file": str(p),
                "status": "skipped",
                "reason": f"이전 {app} 실행 실패로 인한 연속 실행 중단",
            })
            continue

        try:
            if ext == ".docx":
                sub_out = Path(out_dir) / f"{p.stem}_{ext.lstrip('.')}"
                res = process_word(p, sub_out, timeout=timeout, workspace=workspace)
            elif ext == ".xlsx":
                sub_out = Path(out_dir) / f"{p.stem}_{ext.lstrip('.')}"
                res = process_excel(p, sub_out, timeout=timeout, workspace=workspace)
            else:
                res = {"file": str(p), "status": "unsupported", "reason": f"지원하지 않는 확장자: {ext}"}
        except TimeoutError as exc:
            res = {
                "file": str(p),
                "status": "fail",
                "app": app,
                "error": f"[{app} 시간 초과: -1712] {exc}",
            }
        except Exception as exc:
            res = {
                "file": str(p),
                "status": "fail",
                "app": app,
                "error": str(exc),
            }

        results.append(res)

        if res.get("status") == "fail":
            err = res.get("error", "")
            # Only transport-level failures (permission/timeouts) stop the remaining
            # files of the same app; content-validation failures do not.
            if (
                res.get("returncode") == -1712
                or "시간 초과" in err
                or "권한 오류" in err
                or "-1743" in err
            ):
                failed_apps.add(app)
            if "권한 오류" in err or "-1743" in err:
                if err not in permission_instructions:
                    permission_instructions.append(err)

    all_passed = all(r.get("status") in ("converted", "pass") for r in results)
    return {
        "status": "converted" if all_passed else "fail",
        "results": results,
        "permission_instructions": permission_instructions,
    }


def doctor(workspace: str | Path | None = None) -> dict:
    """Checks environment readiness for Office automation."""
    ws_root = Path(workspace).resolve() if workspace else DEFAULT_GROUP_CONTAINER_DIR
    ws_writable = False
    try:
        ws_root.mkdir(parents=True, exist_ok=True)
        test_file = ws_root / f".write_test_{uuid.uuid4().hex[:6]}"
        test_file.write_text("ok")
        test_file.unlink(missing_ok=True)
        ws_writable = True
    except Exception:
        ws_writable = False

    osascript_avail = shutil.which("osascript") is not None
    pywin32_avail = importlib.util.find_spec("win32com") is not None
    pypdf_avail = importlib.util.find_spec("pypdf") is not None

    if sys.platform == "darwin":
        word_app = Path("/Applications/Microsoft Word.app").exists()
        excel_app = Path("/Applications/Microsoft Excel.app").exists()
    elif sys.platform == "win32":
        word_app = _windows_com_app_registered("Word.Application")
        excel_app = _windows_com_app_registered("Excel.Application")
    else:
        word_app = False
        excel_app = False

    engine_available = (
        (sys.platform == "darwin" and osascript_avail)
        or (sys.platform == "win32" and pywin32_avail)
    )

    return {
        "group_container_path": str(ws_root),
        "group_container_writable": ws_writable,
        "osascript_available": osascript_avail,
        "pywin32_available": pywin32_avail,
        "word_installed": word_app,
        "excel_installed": excel_app,
        "pypdf_available": pypdf_avail,
        "platform": sys.platform,
        "engine_available": engine_available,
        "notice": "작업영역 진단 완료. 실제 샌드박스/COM 파일 접근 및 자동화 권한은 네이티브 앱 실행 시험으로 확인합니다. Word/Excel 자동화는 macOS(AppleScript)·Windows(COM, pywin32 필요)만 지원합니다.",
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Office macOS/Windows 자동화 변환 CLI")
    sub = ap.add_subparsers(dest="command", required=True)

    # word subcommand
    sp_w = sub.add_parser("word", help="DOCX 인덱스 필드 갱신·페이지 매김 및 PDF 내보내기")
    sp_w.add_argument("input", help="입력 DOCX 파일 경로")
    sp_w.add_argument("--out-dir", "--out", dest="out_dir", required=True, help="새 대상 출력 디렉터리")
    sp_w.add_argument("--resources", nargs="*", default=[], help="동반 리소스 파일 목록")
    sp_w.add_argument("--timeout", type=int, default=90, help="AppleScript 타임아웃(초)")
    sp_w.add_argument("--workspace", default=None, help="커스텀 Group Container 작업영역 경로")
    sp_w.add_argument("--json", action="store_true", help="JSON 출력")

    # excel subcommand
    sp_e = sub.add_parser("excel", help="XLSX 전 시트 재계산 및 동일 세션 PDF 내보내기")
    sp_e.add_argument("input", help="입력 XLSX 파일 경로")
    sp_e.add_argument("--out-dir", "--out", dest="out_dir", required=True, help="새 대상 출력 디렉터리")
    sp_e.add_argument("--resources", nargs="*", default=[], help="동반 리소스 파일 목록")
    sp_e.add_argument("--template-receipt", default=None, help="입력 XLSX 해시와 일치하는 fill 영수증; 원본 양식 보존 검사, 내용 판정 별도")
    sp_e.add_argument("--spec", default=None, help="학교 17시트 검증용 입력 명세 JSON 경로")
    sp_e.add_argument("--timeout", type=int, default=90, help="AppleScript 타임아웃(초)")
    sp_e.add_argument("--workspace", default=None, help="커스텀 Group Container 작업영역 경로")
    sp_e.add_argument("--json", action="store_true", help="JSON 출력")

    sp_l = sub.add_parser("verify-template-lineage", help="원본 입력부터 현재 XLSX까지 영수증 연결 검사; 내용 승인 아님")
    sp_l.add_argument("input")
    sp_l.add_argument("--receipts", nargs="+", required=True)
    sp_l.add_argument("--json", action="store_true")

    # batch subcommand
    sp_b = sub.add_parser("batch", help="Word/Excel 파일 연속 일괄 처리")
    sp_b.add_argument("inputs", nargs="+", help="입력 DOCX/XLSX 파일 경로들")
    sp_b.add_argument("--out-dir", "--out", dest="out_dir", required=True, help="새 대상 출력 기본 디렉터리")
    sp_b.add_argument("--timeout", type=int, default=90, help="AppleScript 타임아웃(초)")
    sp_b.add_argument("--workspace", default=None, help="커스텀 Group Container 작업영역 경로")
    sp_b.add_argument("--json", action="store_true", help="JSON 출력")

    # doctor subcommand
    sp_doc = sub.add_parser("doctor", help="Office 작업영역 및 의존성 진단")
    sp_doc.add_argument("--workspace", default=None, help="커스텀 Group Container 작업영역 경로")
    sp_doc.add_argument("--json", action="store_true", help="JSON 출력")

    a = ap.parse_args(argv)

    try:
        if a.command == "word":
            res = process_word(
                input_file=a.input,
                out_dir=a.out_dir,
                resources=a.resources,
                timeout=a.timeout,
                workspace=a.workspace,
            )
        elif a.command == "excel":
            res = process_excel(
                input_file=a.input,
                out_dir=a.out_dir,
                resources=a.resources,
                spec_file=a.spec,
                template_receipt=a.template_receipt,
                timeout=a.timeout,
                workspace=a.workspace,
            )
        elif a.command == "verify-template-lineage":
            res = verify_template_lineage(a.input, a.receipts)
        elif a.command == "batch":
            res = process_batch(
                files=a.inputs,
                out_dir=a.out_dir,
                timeout=a.timeout,
                workspace=a.workspace,
            )
        elif a.command == "doctor":
            res = doctor(workspace=a.workspace)
        else:
            res = {"status": "fail", "reason": f"알 수 없는 명령: {a.command}"}

        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res.get("status") in ("converted", "pass", "generated") or a.command == "doctor" else 1

    except Exception as e:
        err_res = {"status": "blocked", "reason": str(e)}
        print(json.dumps(err_res, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
