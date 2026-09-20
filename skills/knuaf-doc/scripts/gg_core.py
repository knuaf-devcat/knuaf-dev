"""Provider-neutral project state. All mutations use locked, revisioned transactions."""

from pathlib import Path
from decimal import Decimal, InvalidOperation
import copy
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = "1.0"
STATES = {
    "not_provided",
    "explicit_none",
    "unknown",
    "provided",
    "not_applicable",
    "withheld",
}
KINDS = {"reported_fact", "observation", "assumption", "target", "derived"}
VERIFY = {"unreviewed", "source_located", "claim_supported", "disputed", "superseded"}
START, END = "<!-- gg:draft:start -->", "<!-- gg:draft:end -->"
COLLECTIONS = (
    "sources",
    "facts",
    "sections",
    "questions",
    "tasks",
    "reviews",
    "rules",
    "approvals",
    "outputs",
)


def digest(value):
    data = (
        value
        if isinstance(value, bytes)
        else json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    )
    return hashlib.sha256(data).hexdigest()


def local(root, name):
    root = Path(root).resolve()
    p = (root / name).resolve()
    if not p.is_relative_to(root) or p == root:
        raise ValueError("작업 폴더 밖 경로는 허용하지 않음: " + str(name))
    return p


def draft(text):
    if START in text or END in text:
        if (
            text.count(START) != 1
            or text.count(END) != 1
            or text.index(START) > text.index(END)
        ):
            raise ValueError("DRAFT 경계 손상")
        return text.split(START)[1].split(END)[0].strip()
    m = re.search(
        r"^##\s+DRAFT[^\n]*\n(.*?)(?=^##\s+(?:STATUS|INPUT|RESEARCH|FACTS|OPEN)\b|\Z)",
        text,
        re.M | re.S,
    )
    return m.group(1).strip() if m else text.strip()


META_BLOCK = re.compile(r"^##\s+(?:STATUS|INPUT|RESEARCH|FACTS|OPEN)\b")
TITLE_LINE = re.compile(r"^#\s+\S")
DRAFT_HEAD = re.compile(r"^##\s+DRAFT\b")


def draft_marker_extra(raw):
    """Text outside well-formed gg:draft markers that is not envelope.

    draft() exposes only the marked slice, so any other stored text never
    reaches merged()/checks.  The accepted envelope is the legacy six-block
    metadata (`## STATUS|INPUT|RESEARCH|FACTS|OPEN` sections), a `# ` title
    line, and the `## DRAFT` heading that labels the marked slice.  Anything
    else is returned so callers can flag the divergence; the raw file is
    never modified.  Returns the residue text or None.
    """
    if raw.count(START) != 1 or raw.count(END) != 1:
        return None
    if raw.index(START) > raw.index(END):
        return None
    before = raw[: raw.index(START)].splitlines()
    after = raw[raw.index(END) + len(END):].splitlines()
    # A trailing `## DRAFT` heading belongs to the marked slice itself, but
    # only when nothing but blank lines follows it.
    for i in range(len(before) - 1, -1, -1):
        if before[i].strip():
            if DRAFT_HEAD.match(before[i]):
                before = before[:i]
            break
    extra = []
    in_meta = False
    for line in before:
        if line.startswith("##"):
            in_meta = bool(META_BLOCK.match(line))
            if not in_meta:
                extra.append(line)
            continue
        if line.strip() and not in_meta and not TITLE_LINE.match(line):
            extra.append(line)
    in_meta = False
    for line in after:
        if line.startswith("##"):
            in_meta = bool(META_BLOCK.match(line))
            if not in_meta:
                extra.append(line)
            continue
        if line.strip() and not in_meta:
            extra.append(line)
    return "\n".join(extra).strip() or None


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".gg-tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _replace_with_retry(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _replace_with_retry(src, dst, attempts=4):
    """os.replace, retried briefly on Windows PermissionError (AV/editor handles)."""
    delay = 0.05
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if sys.platform != "win32" or i == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 3


def load(root):
    p = json.loads((Path(root) / "project.json").read_text(encoding="utf-8"))
    validate(p)
    return p


def init(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with Lock(root):
        if (root / "project.json").exists():
            raise ValueError("기존 정본을 덮어쓰지 않음")
        p = dict(
            schema_version=2,
            revision=0,
            project_id=uuid.uuid4().hex,
            requests={},
            views={},
            issues=[],
            history=[],
        )
        p.update({k: {} for k in COLLECTIONS})
        atomic(
            root / "project.json", json.dumps(p, ensure_ascii=False, indent=2).encode()
        )
        # Directories the references tell the model to write into. Creating them
        # here keeps the documented layout and the real one in agreement; before
        # this they existed only in prose, so nothing ever checked them.
        for rel in ("sources/extracts", "audit/model-routing"):
            (root / rel).mkdir(parents=True, exist_ok=True)
    return p


_FD_LOCKING = (
    hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.unlink in os.supports_dir_fd
)
_REPARSE_POINT = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
# POSIX rename() replaces an existing empty directory; Windows MoveFileEx
# does not. Module-level so tests can exercise the Windows branch anywhere.
_DIR_RENAME_REPLACES = sys.platform != "win32"


class _DirRef:
    """Operations on entries of one directory, bound to that directory.

    POSIX: an O_DIRECTORY|O_NOFOLLOW descriptor and dir_fd= calls, so a
    directory swapped underneath us can never be written through.
    Windows (no dir_fd): path based; symlinks/junctions are refused via the
    reparse-point attribute and the directory identity is re-checked around
    each step. That is a weaker guarantee and section-ledger.md says so.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.fd = None
        if _FD_LOCKING:
            self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        else:
            self._refuse_reparse(self.path)
            if not self.path.is_dir():
                raise NotADirectoryError(str(self.path))

    @staticmethod
    def _refuse_reparse(path):
        st = os.lstat(path)
        if os.path.islink(path) or (getattr(st, "st_file_attributes", 0) & _REPARSE_POINT):
            raise OSError("심볼릭 링크/정션은 잠금 경로로 허용하지 않음: " + str(path))
        return st

    def identity(self):
        st = os.fstat(self.fd) if self.fd is not None else os.lstat(self.path)
        return (st.st_dev, st.st_ino)

    def open(self, name, flags, mode=0o600):
        if self.fd is not None:
            return os.open(name, flags | os.O_NOFOLLOW, mode, dir_fd=self.fd)
        target = self.path / name
        if os.path.lexists(target):
            self._refuse_reparse(target)
        return os.open(target, flags | getattr(os, "O_BINARY", 0), mode)

    def stat(self, name):
        if self.fd is not None:
            return os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        return os.lstat(self.path / name)

    def unlink(self, name):
        if self.fd is not None:
            os.unlink(name, dir_fd=self.fd)
        else:
            os.unlink(self.path / name)

    def link(self, source, name):
        """Hard-link `source` as `name`; copy atomically where links are impossible."""
        source = Path(source)
        try:
            if self.fd is not None:
                os.link(source, name, dst_dir_fd=self.fd)
            else:
                os.link(source, self.path / name)
            return "link"
        except OSError as error:
            if getattr(error, "errno", None) not in (1, 18, 95, 38, 22) and sys.platform != "win32":
                raise  # EPERM/EXDEV/EOPNOTSUPP/ENOSYS/EINVAL fall back; anything else is real
            data = source.read_bytes()
            atomic(self.path / name, data)
            if digest((self.path / name).read_bytes()) != digest(data):
                raise ValueError("복사 발행 후 해시 불일치: " + name) from error
            return "copy"

    def fsync(self):
        if self.fd is not None:
            os.fsync(self.fd)

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def _same_marker(a, b):
    """True when two publication markers are the same file, or byte-identical
    (copy fallback on filesystems without hard links)."""
    a, b = Path(a), Path(b)
    try:
        if a.samefile(b):
            return True
    except OSError:
        return False
    try:
        data = a.read_bytes()
        return bool(data) and data == b.read_bytes() and b"token" in data
    except OSError:
        return False


class Lock:
    def __init__(self, root):
        self.path = Path(root) / ".gg-lock"
        self.token = uuid.uuid4().hex
        self.identity = None

    def __enter__(self):
        try:
            self.path.mkdir()
        except FileExistsError:
            raise ValueError(
                "쓰기 잠금 존재: 실행 중인 작성자를 확인 후 doctor/lock-info로 복구 판단 (잔류 잠금은 unlock)"
            )
        self.owner = {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "token": self.token,
            "acquired_at": time.time(),
            "python": sys.executable,
            "argv0": sys.argv[0] if sys.argv else None,
        }
        directory = None
        owner_identity = None
        try:
            stat = os.lstat(self.path)
            self.identity = (stat.st_dev, stat.st_ino)
            directory = _DirRef(self.path)
            if directory.identity() != self.identity:
                raise OSError("잠금 디렉터리 교체: 획득 중단")
            owner_fd = directory.open("owner.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(owner_fd, "w", encoding="utf-8") as owner_file:
                stat = os.fstat(owner_file.fileno())
                owner_identity = (stat.st_dev, stat.st_ino)
                owner_file.write(json.dumps(self.owner))
                owner_file.flush()
                os.fsync(owner_file.fileno())
            stat = os.lstat(self.path)
            if (stat.st_dev, stat.st_ino) != self.identity:
                raise OSError("잠금 디렉터리 교체: 획득 중단")
        except BaseException:
            # Whatever went wrong (OSError, a missing platform API,
            # KeyboardInterrupt...), the directory we just created must not
            # survive as an orphan lock (audit C1/C4).
            try:
                if directory is not None and owner_identity is not None:
                    stat = directory.stat("owner.json")
                    if (stat.st_dev, stat.st_ino) == owner_identity:
                        directory.unlink("owner.json")
                if self.identity is None:
                    self.path.rmdir()
                else:
                    stat = os.lstat(self.path)
                    if (stat.st_dev, stat.st_ino) == self.identity:
                        self.path.rmdir()
            except OSError:
                self.identity = None
            raise
        finally:
            if directory is not None:
                directory.close()
        return self

    def __exit__(self, *args):
        directory = None
        try:
            directory = _DirRef(self.path)
            if directory.identity() != self.identity:
                raise ValueError(
                    "쓰기 잠금 디렉터리 교체: 자기 잠금이 아니므로 정리하지 않음: "
                    + str(self.path)
                )
            owner_state = "missing"
            try:
                owner_fd = directory.open("owner.json", os.O_RDONLY)
            except FileNotFoundError:
                owner_fd = None
            else:
                with os.fdopen(owner_fd, encoding="utf-8") as owner_file:
                    stat = os.fstat(owner_file.fileno())
                    owner_identity = (stat.st_dev, stat.st_ino)
                    data = owner_file.read()
                    owner_file.seek(0)
                    if owner_file.read() != data:
                        owner_state = "replacement_owner"
                    else:
                        try:
                            owner = json.loads(data)
                        except json.JSONDecodeError as error:
                            owner_state = "corrupt_owner_record: " + str(error)
                        else:
                            if owner != self.owner:
                                owner_state = "replacement_owner"
                            else:
                                stat = directory.stat("owner.json")
                                owner_state = (
                                    "ours"
                                    if (stat.st_dev, stat.st_ino) == owner_identity
                                    else "replacement_owner"
                                )
            if owner_state == "ours":
                # Same-inode rewrites (truncate + write) change only the
                # contents, so re-read the record after json.loads and
                # before deletion. inode alone cannot catch this.
                try:
                    recheck_fd = directory.open("owner.json", os.O_RDONLY)
                except FileNotFoundError:
                    owner_state = "missing"
                else:
                    with os.fdopen(recheck_fd, encoding="utf-8") as recheck_file:
                        stat = os.fstat(recheck_file.fileno())
                        if (stat.st_dev, stat.st_ino) != owner_identity:
                            owner_state = "replacement_owner"
                        else:
                            try:
                                current = json.loads(recheck_file.read())
                            except json.JSONDecodeError:
                                # A same-inode rewrite with broken JSON is our
                                # own record gone bad, not a replacement's
                                # valid claim: release the lock (C9/F2).
                                owner_state = "corrupt_owner_record: re-read"
                            else:
                                if current != self.owner:
                                    owner_state = "replacement_owner"
            if owner_state == "replacement_owner":
                # A valid owner record replaced ours; preserve it untouched.
                return
            # Missing, corrupt, or ours: a single unlink of our own record.
            # Never unlink twice (FileNotFoundError must not leak from a
            # redundant second unlink).
            try:
                directory.unlink("owner.json")
            except FileNotFoundError:
                pass
            directory.close()
            stat = os.lstat(self.path)
            if (stat.st_dev, stat.st_ino) != self.identity:
                return
            released = self.path.with_name(".gg-tmp-lock-" + self.token)
            self.path.rename(released)
            stat = os.lstat(released)
            if (stat.st_dev, stat.st_ino) != self.identity:
                if not self.path.exists():
                    try:
                        released.rename(self.path)
                    except FileExistsError:
                        return
                return
            released.rmdir()
        finally:
            if directory is not None:
                directory.close()


def validate(p):
    if (
        p.get("schema_version") not in (1, 2)
        or type(p.get("revision")) is not int
    ):
        raise ValueError("지원하지 않는 정본 스키마")
    for c in COLLECTIONS:
        if not isinstance(p.get(c), dict):
            raise ValueError("잘못된 컬렉션: " + c)
        for key, v in p[c].items():
            if (
                not isinstance(key, str)
                or not key
                or not isinstance(v, dict)
                or v.get("id") != key
                or type(v.get("revision")) is not int
            ):
                raise ValueError("ID/개정번호 오류: " + str(key))
    for q in p["questions"].values():
        if (
            q.get("field_id") != q["id"]
            or type(q.get("attempts")) is not int
            or q["attempts"] < 0
            or type(q.get("decision_revision")) is not int
            or q["decision_revision"] < 1
        ):
            raise ValueError("질문 ID/횟수/결정 개정 오류")
    for s in p["sections"].values():
        if (
            s.get("status") not in {"empty", "drafting", "review_ready"}
            or type(s.get("order")) is not int
            or not s.get("title")
            or not s.get("path")
        ):
            raise ValueError("절 상태/순서/제목/경로 오류")
    for f in p["facts"].values():
        for key in (
            "field_id",
            "kind",
            "value",
            "unit",
            "value_type",
            "period",
            "scope",
            "answer_state",
            "verification",
            "source_refs",
        ):
            if key not in f:
                raise ValueError("사실 필드 누락: " + key)
        if (
            f["kind"] not in KINDS
            or f["answer_state"] not in STATES
            or f["verification"] not in VERIFY
        ):
            raise ValueError("잘못된 사실 상태")
        if f["answer_state"] == "provided" and f["value"] is None:
            raise ValueError("제공됨 상태에는 값 필요")
        if f["answer_state"] != "provided" and f["value"] is not None:
            raise ValueError("미제공/없음/거부를 수치로 변환할 수 없음")
        if f["answer_state"] in {
            "explicit_none",
            "withheld",
            "not_applicable",
        } and not f.get("reason"):
            raise ValueError("상태 사유 필요")
        if f["answer_state"] != "not_provided" and not f["source_refs"]:
            raise ValueError("원답변/원자료 참조 필요")
        if f["value_type"] == "decimal" and f["value"] is not None:
            try:
                if (
                    not isinstance(f["value"], str)
                    or not Decimal(f["value"]).is_finite()
                ):
                    raise ValueError("수치는 유한 십진 문자열이어야 함")
            except InvalidOperation as e:
                raise ValueError("유효한 십진 문자열 필요") from e
            if (
                not f["unit"]
                or not f["scope"]
                or (f["period"] is None and not f.get("period_reason"))
            ):
                raise ValueError("수치의 단위·기간·범위 필요")
        for ref in f["source_refs"]:
            if ref.get("id") not in p["sources"] or not ref.get("locator"):
                raise ValueError("원자료/위치 누락")
        if f["kind"] == "derived" and (not f.get("formula") or not f.get("input_refs")):
            raise ValueError("계산식/입력 필요")
    if p.get("parent_hash") is not None:
        hist = p.get("history") or []
        if not hist or hist[-1].get("hash") != p["parent_hash"]:
            raise ValueError("정본 계보 불일치: parent_hash가 history와 맞지 않음")
    visiting, visited = set(), set()

    def visit(key):
        if key in visiting:
            raise ValueError("순환 계산: " + key)
        if key in visited:
            return
        visiting.add(key)
        for r in p["facts"][key].get("input_refs", []):
            if r["id"] not in p["facts"]:
                raise ValueError("계산 입력 없음")
            visit(r["id"])
        visiting.remove(key)
        visited.add(key)

    for key in p["facts"]:
        visit(key)


def _check_ref(ref):
    if (
        not isinstance(ref, dict)
        or ref.get("collection") not in COLLECTIONS
        or not isinstance(ref.get("id"), str)
    ):
        raise ValueError("잘못된 대상 참조: " + str(ref))


def node(p, ref):
    _check_ref(ref)
    try:
        return p[ref["collection"]][ref["id"]]
    except KeyError as e:
        raise ValueError("대상 기록 없음: " + str(ref)) from e


def fingerprint(root, p, refs):
    seen = set()

    def resolve(ref):
        _check_ref(ref)
        k = (ref["collection"], ref["id"])
        if k in seen:
            return list(k)
        seen.add(k)
        v = copy.deepcopy(node(p, ref))
        v.pop("stale", None)
        if "path" in v:
            path = local(root, v["path"])
            content = path.read_bytes()
            v["actual_hash"] = (
                digest(draft(content.decode()))
                if ref["collection"] == "sections"
                else digest(content)
            )
        v["resolved_dependencies"] = [resolve(x) for x in v.get("depends_on", [])]
        if ref["collection"] == "outputs":
            v["resolved_targets"] = [resolve(x) for x in v.get("target_refs", [])]
        if ref["collection"] == "facts":
            v["resolved_sources"] = [
                resolve({"collection": "sources", "id": x["id"]})
                for x in v["source_refs"]
            ]
            v["resolved_inputs"] = [
                resolve({"collection": "facts", "id": x["id"]})
                for x in v.get("input_refs", [])
            ]
        return v

    targets = [resolve(r) for r in refs]
    rules = {}
    for key, rule in p["rules"].items():
        scope = rule.get("applies_to")
        resolved_scope = (
            isinstance(scope, list)
            and bool(scope)
            and all(
                isinstance(ref, dict)
                and ref.get("collection") in COLLECTIONS
                and isinstance(ref.get("id"), str)
                and ref["id"] in p[ref["collection"]]
                for ref in scope
            )
        )
        if not resolved_scope or any(
            (ref["collection"], ref["id"]) in seen for ref in scope
        ):
            rules[key] = rule
    return digest({"targets": targets, "rules": rules})


def fingerprint_v1(root, p, refs):
    """Schema-1 fingerprint formula, kept only for the schema upgrade path."""
    seen = set()

    def resolve(ref):
        _check_ref(ref)
        k = (ref["collection"], ref["id"])
        if k in seen:
            return list(k)
        seen.add(k)
        v = copy.deepcopy(node(p, ref))
        v.pop("stale", None)
        if "path" in v:
            path = local(root, v["path"])
            content = path.read_bytes()
            v["actual_hash"] = (
                digest(draft(content.decode()))
                if ref["collection"] == "sections"
                else digest(content)
            )
        v["resolved_dependencies"] = [resolve(x) for x in v.get("depends_on", [])]
        return v

    return digest({"targets": [resolve(r) for r in refs], "rules": p["rules"]})


def _upgrade_schema_records(root, p):
    """Recompute fingerprints under the schema-2 formula.

    A stored fingerprint that still matches the schema-1 formula means the
    record's real dependencies are unchanged: its fingerprint is rewritten
    with the new formula and it must not become stale.  A stored fingerprint
    that no longer matches means the dependencies actually changed: the
    record goes stale and keeps its old fingerprint until it is re-registered.
    """
    for col in ("reviews", "approvals", "outputs"):
        for v in p[col].values():
            refs = v.get("target_refs")
            try:
                v1_fp = fingerprint_v1(root, p, refs)
                new_fp = fingerprint(root, p, refs)
            except (KeyError, TypeError, OSError, ValueError):
                v["stale"] = True
                continue
            if v.get("input_fingerprint") == v1_fp:
                v["input_fingerprint"] = new_fp
                v["stale"] = False
            else:
                v["stale"] = True
    return p


def upgrade_schema(root):
    """Upgrade a schema-1 project to schema 2 without invalidating reviews.

    Fingerprints are recomputed with the new formula; records whose actual
    dependencies are unchanged must not become stale.  This is separate from
    the legacy Markdown-folder ``migrate`` import path.
    """
    root = Path(root)
    with Lock(root):
        p = load(root)
        if p["schema_version"] == 2:
            return p
        _upgrade_schema_records(root, p)
        p["schema_version"] = 2
        atomic(
            root / "project.json",
            json.dumps(p, ensure_ascii=False, indent=2).encode(),
        )
        return p


def apply(root, change, expected_revision):
    root = Path(root)
    with Lock(root):
        p = load(root)
        if p["schema_version"] == 1:
            # Route schema-1 projects through the fingerprint upgrade before
            # any apply-time comparison; do not reject or invalidate them.
            _upgrade_schema_records(root, p)
            p["schema_version"] = 2
            atomic(
                root / "project.json",
                json.dumps(p, ensure_ascii=False, indent=2).encode(),
            )
        request = change.get("request_id")
        if not isinstance(request, str) or not request:
            raise ValueError("요청 ID 필요")
        chash = digest(change)
        if request in p["requests"]:
            if p["requests"][request]["hash"] != chash:
                raise ValueError("동일 요청 ID의 내용 충돌")
            return p
        if p["revision"] != expected_revision:
            raise ValueError("개정 충돌: 최신 정본을 다시 읽어야 함")
        if "result_of" in change:
            origin = change["result_of"]
            if not isinstance(origin, dict):
                raise ValueError("작업 결과 실행 식별 필요")
            if not isinstance(origin.get("task_id"), str) or not origin["task_id"]:
                raise ValueError("작업 결과 작업 ID 필요")
            execution = p["tasks"].get(origin.get("task_id"), {}).get("execution", {})
            for identity in (origin, execution):
                if (
                    not isinstance(identity, dict)
                    or not isinstance(identity.get("external_task_id"), str)
                    or not identity["external_task_id"]
                    or type(identity.get("epoch")) is not int
                    or identity["epoch"] < 1
                    or type(identity.get("input_revision")) is not int
                    or not 0 <= identity["input_revision"] <= expected_revision
                ):
                    raise ValueError("작업 실행 ID·차수·입력 개정 필요")
            if (
                execution.get("status") != "running"
                or any(
                    key not in origin
                    or origin[key] != execution.get(key)
                    for key in ("epoch", "external_task_id", "input_revision")
                )
            ):
                raise ValueError("취소·미확인·이전 실행의 작업 결과는 반영하지 않음")
            if not isinstance(execution.get("target_refs"), list):
                raise ValueError("실행 입력 대상 기록 필요")
            try:
                current_input = fingerprint(root, p, execution["target_refs"])
            except (KeyError, TypeError, OSError) as error:
                raise ValueError("실행 입력 대상을 확인할 수 없음") from error
            if execution.get("input_fingerprint") != current_input:
                raise ValueError("실행 이후 입력 변경: 작업 결과 반영 거부")
            allowed_targets = {
                (ref.get("collection"), ref.get("id"))
                for ref in execution["target_refs"]
            }
            for op in change.get("ops", []):
                if (
                    not isinstance(op, dict)
                    or not isinstance(op.get("value"), dict)
                    or (
                        op.get("collection") != "tasks"
                        and (op.get("collection"), op["value"].get("id"))
                        not in allowed_targets
                    )
                ):
                    raise ValueError(
                        "작업 실행 대상 범위 밖 변경: "
                        + str(op.get("collection") if isinstance(op, dict) else op)
                    )
        p.setdefault("project_id", uuid.uuid4().hex)
        old = copy.deepcopy(p)
        meta_linked = set()
        for op in change.get("ops", []):
            col, value = op["collection"], copy.deepcopy(op["value"])
            if col not in COLLECTIONS:
                raise ValueError("허용되지 않은 변경 컬렉션")
            key = value.get("id")
            if not isinstance(key, str) or not key:
                raise ValueError("ID는 비어 있지 않은 문자열이어야 함: " + repr(key))
            prev = p[col].get(key)
            value["revision"] = prev["revision"] + 1 if prev else 1
            if (
                col == "questions"
                and prev
                and value.get("decision_revision") != prev.get("decision_revision")
            ):
                if value.get("resume_reason") not in {
                    "new_evidence",
                    "user_change",
                    "explicit_resume",
                } or not value.get("source_ref"):
                    raise ValueError("질문 재개에는 새 근거/사용자 결정 필요")
                if (
                    value["decision_revision"] != prev["decision_revision"] + 1
                    or value["source_ref"].get("id") not in p["sources"]
                ):
                    raise ValueError("질문 재개 근거/결정 개정 불일치")
            elif (
                col == "questions"
                and prev
                and value.get("attempts", -1) < prev["attempts"]
            ):
                raise ValueError("동일 결정의 질문 횟수를 초기화할 수 없음")
            if col == "sections":
                value["draft_hash"] = digest(
                    draft(local(root, value["path"]).read_text(encoding="utf-8"))
                )
            if col == "sources":
                value["hash"] = digest(local(root, value["path"]).read_bytes())
            if col == "outputs":
                if _meta_only_link(prev, value):
                    _meta_only_link_verify(root, p, key, value, prev)
                    meta_linked.add(key)
                elif not value.get("target_refs") or value.get(
                    "input_fingerprint"
                ) != fingerprint(root, p, value["target_refs"]):
                    raise ValueError("출력 입력 버전/대상 불일치")
                elif value.get("file_hash") != digest(
                    local(root, value["path"]).read_bytes()
                ):
                    raise ValueError("검사한 출력 파일 해시 불일치")
            if col == "approvals" and value.get("kind") == "professor":
                if value.get("input_revision") != expected_revision:
                    raise ValueError("교수 승인 입력 개정 불일치")
                evidence_rel = value.get("evidence_path")
                if not isinstance(evidence_rel, str) or not evidence_rel.strip():
                    raise ValueError("교수 승인 근거 파일 필요")
                evidence_bytes = local(root, evidence_rel).read_bytes()
                if value.get("evidence_hash") != digest(evidence_bytes):
                    raise ValueError("교수 승인 근거 해시 불일치")
                value["registered_revision"] = expected_revision + 1
            if col == "reviews":
                for required in (
                    "review_kind",
                    "author_id",
                    "reviewer_id",
                    "target_refs",
                    "input_fingerprint",
                    "findings",
                    "disposition",
                    "status",
                    "path",
                ):
                    if required not in value:
                        raise ValueError("검토 필드 누락: " + required)
                if value["author_id"] == value["reviewer_id"]:
                    raise ValueError("자가검토는 독립검토가 아님")
                if not value["target_refs"] or not value.get("coverage"):
                    raise ValueError("검토 대상과 축별 위치 근거 필요")
                if value["input_fingerprint"] != fingerprint(
                    root, p, value["target_refs"]
                ):
                    raise ValueError("검토 입력 버전 불일치")
                value["report_hash"] = digest(local(root, value["path"]).read_bytes())
            p[col][key] = value
        p["parent_hash"] = digest(old)
        p["history"].append(
            {"revision": old["revision"], "hash": p["parent_hash"], "request_id": request}
        )
        validate(p)
        p["revision"] += 1
        for col in ("reviews", "approvals", "outputs"):
            for v in p[col].values():
                try:
                    v["stale"] = v.get("input_fingerprint") != fingerprint(
                        root, p, v["target_refs"]
                    )
                except (KeyError, OSError, ValueError):
                    v["stale"] = True
        if meta_linked:
            _meta_only_links_final_check(root, p, meta_linked)
        p["requests"][request] = {"hash": chash, "revision": p["revision"]}
        atomic(
            local(root, "migration/revision-%s.json" % old["revision"]),
            json.dumps(old, ensure_ascii=False, indent=2).encode(),
        )
        atomic(
            root / "project.json", json.dumps(p, ensure_ascii=False, indent=2).encode()
        )
        return p


def question(p, field_id):
    facts = [f for f in p["facts"].values() if f["field_id"] == field_id]
    if any(
        f["answer_state"] in {"provided", "explicit_none", "not_applicable", "withheld"}
        for f in facts
    ):
        return "reuse"
    q = p["questions"].get(field_id, {})
    return ("ask", "help", "deferred")[min(q.get("attempts", 0), 2)]


def user_finish_task_list(p):
    formats = p.get("rules", {}).get("output_formats", {}).get("formats", [])
    items = []
    if "hwp" in formats:
        items.append(
            (
                "hwp_convert",
                "DOCX를 한글에서 HWP로 저장한 뒤 재열기·렌더·표/인용/핵심 수치 대조",
            )
        )
    items.extend(
        (
            ("font_shinmyeongjo", "글꼴 신명조 확인·변경"),
            ("margins", "여백 위20/아래15/머리15/꼬리15/좌30/우30/제본0 mm"),
            ("page_numbers", "페이지 번호"),
        )
    )
    return [
        {
            "id": cid,
            "status": "needs_user",
            "owner": "user",
            "missing": [],
            "reason": reason,
        }
        for cid, reason in items
    ]


def next_tasks(p):
    result = []
    for t in p["tasks"].values():
        missing = []
        for fid in t.get("required_fields", []):
            if not any(
                f["field_id"] == fid and f["answer_state"] == "provided"
                for f in p["facts"].values()
            ):
                missing.append(fid)
        result.append(
            {
                "id": t["id"],
                "status": (
                    "needs_user"
                    if missing and t.get("user_owned")
                    else "needs_evidence" if missing else "ready"
                ),
                "missing": missing,
            }
        )
    result.extend(user_finish_task_list(p))
    return result


def result(
    cid,
    target,
    status,
    reason,
    revision,
    severity="error",
    evidence=None,
    owner="skill",
    required_for=None,
):
    if owner not in {"skill", "user", "professor"}:
        raise ValueError("검사 소유자 오류")
    if required_for is None:
        required_for = ["submission_candidate"] if severity == "error" else []
    return dict(
        check_id=cid,
        target=target,
        status=status,
        severity=severity,
        reason=reason,
        evidence=evidence or [],
        owner=owner,
        required_for=list(required_for),
        input_revision=revision,
        checker_version=VERSION,
    )


VISUAL_FAIL = {
    "FONT-SUBSTITUTION": "font",
    "TOC-PAGE-NUMBERS": "render",
    "WIDE-TABLE-MONTH-WRAP": "render",
    "MISSING-VISIBLE-FIGURE": "render",
    "EXCEL-PRINT-CLIPPING": "render",
}


def visual_review_blocks(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return set()
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
        return set()
    blocked = set()
    for finding in data["findings"]:
        if not isinstance(finding, dict):
            continue
        cid = VISUAL_FAIL.get(finding.get("id"))
        if cid and finding.get("status") == "fail":
            blocked.add(cid)
    if data.get("independent_review") == "not_run" or data.get("self_review"):
        blocked.add("independent_review")
    return blocked


def output_lineage(p):
    """Validate ``superseded_by`` chains and classify every output.

    Each verdict is ``current`` (no valid successor), ``history`` (superseded
    through a valid chain whose terminal output is not stale), or ``invalid``
    (broken relation: self-reference, cycle, missing target, format mismatch,
    or a stale terminal).  Stale alone never makes an output history, a
    broken relation never removes the output from inspection candidacy, and
    filenames/dates/student IDs are never consulted.
    """
    outputs = p.get("outputs", {})
    verdict = {}
    for oid in outputs:
        trail = [oid]
        cur = oid
        reason = None
        terminal = None
        while True:
            link = outputs[cur].get("superseded_by")
            if link is None:
                terminal = cur
                break
            if not isinstance(link, str) or not link:
                reason = "superseded_by가 출력 ID 문자열이 아님"
                break
            if link == cur:
                reason = "superseded_by 자기 참조"
                break
            if link not in outputs:
                reason = "superseded_by 대상 출력 없음: " + link
                break
            if link in trail:
                reason = "superseded_by 순환: " + " -> ".join(trail + [link])
                break
            if outputs[link].get("format") != outputs[cur].get("format"):
                reason = "superseded_by 대상과 format 불일치: " + link
                break
            trail.append(link)
            cur = link
        if reason is not None:
            verdict[oid] = {"state": "invalid", "reason": reason, "terminal": None}
        elif oid == terminal:
            verdict[oid] = {"state": "current", "reason": None, "terminal": oid}
        elif outputs[terminal].get("stale") is True:
            verdict[oid] = {
                "state": "invalid",
                "reason": "superseded_by 최신 출력이 stale: " + terminal,
                "terminal": terminal,
            }
        else:
            verdict[oid] = {"state": "history", "reason": None, "terminal": terminal}
    return verdict


def _meta_only_link(prev, value):
    """superseded_by 첫 연결만 하는 metadata-only 갱신 후보인지 판별한다.

    서버가 관리하는 revision과 superseded_by를 제외한 모든 필드·키 존재가
    저장 레코드와 같아야 한다. id/path/format/file_hash/target_refs/
    input_fingerprint/checks/depends_on/stale 등을 숨겨 바꾸는 면제 경로는
    없다 — 하나라도 다르면 False로 기존 엄격 검증 경로에 남긴다.
    """
    if prev is None:
        return False
    skip = ("superseded_by", "revision")
    base = {k: v for k, v in prev.items() if k not in skip}
    cand = {k: v for k, v in value.items() if k not in skip}
    return (
        cand == base
        and value.get("superseded_by") != prev.get("superseded_by")
    )


def _lineage_terminal_verify(root, p, terminal):
    """계보 끝단의 실제 현재성 — 저장된 stale 플래그를 신뢰하지 않는다."""
    try:
        current = fingerprint(root, p, terminal["target_refs"])
    except (KeyError, TypeError, OSError, ValueError) as e:
        raise ValueError(
            "계보 끝단의 실제 입력을 확인할 수 없음: " + str(e)
        ) from e
    if terminal.get("input_fingerprint") != current:
        raise ValueError("계보 끝단의 실제 입력이 등록 지문과 다름")
    try:
        actual = digest(local(root, terminal["path"]).read_bytes())
    except (KeyError, OSError, ValueError) as e:
        raise ValueError(
            "계보 끝단의 실제 파일을 확인할 수 없음: " + str(e)
        ) from e
    if terminal.get("file_hash") != actual:
        raise ValueError("계보 끝단 파일이 등록 해시와 다름")


def _meta_only_link_verify(root, p, key, value, prev):
    """첫 superseded_by 이력 연결의 전용 검증 — 실패는 폴백 없이 즉시 거부."""
    link = value.get("superseded_by")
    if prev.get("superseded_by") is not None:
        raise ValueError(
            "기존 superseded_by 재연결·해제는 이 경로로 할 수 없음: "
            + str(prev.get("superseded_by"))
        )
    if not isinstance(link, str) or not link:
        raise ValueError("superseded_by가 출력 ID 문자열이 아님")
    if link == key:
        raise ValueError("superseded_by 자기 참조")
    if link not in p["outputs"]:
        raise ValueError("superseded_by 대상 출력 없음: " + link)
    if p["outputs"][link].get("format") != prev.get("format"):
        raise ValueError("superseded_by 대상과 format 불일치: " + link)
    # 원 출력 파일이 존재하면 등록 해시와 실제 바이트가 같아야 한다.
    # 파일 부재만 기존 유실로 허용하고, 읽기 오류·루트 밖 경로·다른 바이트를
    # 유실로 바꾸지 않는다 — 원 path/hash와 유실 사실은 레코드에 보존된다.
    if prev.get("path"):
        try:
            content = local(root, prev["path"]).read_bytes()
        except FileNotFoundError:
            content = None
        except OSError as e:
            raise ValueError(
                "이력 원 출력 파일을 읽을 수 없음: " + str(e)
            ) from e
        if content is not None and digest(content) != prev.get("file_hash"):
            raise ValueError("이력 원 출력 파일이 등록 해시와 다름")
    scratch = copy.deepcopy(p)
    scratch["outputs"][key] = value
    after = output_lineage(scratch)
    if after[key]["state"] != "history":
        raise ValueError(
            "superseded_by 계보 무효: " + str(after[key]["reason"])
        )
    _lineage_terminal_verify(
        root, scratch, scratch["outputs"][after[key]["terminal"]]
    )
    before = output_lineage(p)
    for oid, verdict in after.items():
        if verdict["state"] == "invalid" and before[oid]["state"] != "invalid":
            raise ValueError(
                "superseded_by 연결이 다른 출력을 무효화: " + oid
            )


def _meta_only_links_final_check(root, p, linked):
    """트랜잭션 최종 상태에서 이번 경로로 추가한 링크를 다시 확인한다.

    같은 요청의 뒤 op나 기존 stale 재계산이 새 연결의 끝단을 무효화했을 수
    있으므로 기록·원자 쓰기 전에 유효 history와 끝단의 실제 입력·파일을 다시
    검증한다. 실패하면 요청 전체가 미반영이다. 이미 있던 무관한 invalid는
    유지하되, 이 연결을 지나는 출력이 새로 invalid가 되는 것은 거부한다.
    """
    lineage = output_lineage(p)
    for oid in linked:
        verdict = lineage[oid]
        if verdict["state"] != "history":
            raise ValueError(
                "최종 상태의 superseded_by 계보 무효: "
                + str(verdict["reason"])
            )
        _lineage_terminal_verify(root, p, p["outputs"][verdict["terminal"]])
    for oid, verdict in lineage.items():
        if verdict["state"] != "invalid" or oid in linked:
            continue
        cur, seen = oid, {oid}
        while True:
            nxt = p["outputs"][cur].get("superseded_by")
            if (
                not isinstance(nxt, str)
                or not nxt
                or nxt not in p["outputs"]
                or nxt in seen
            ):
                break
            seen.add(nxt)
            cur = nxt
        if seen & linked:
            raise ValueError(
                "superseded_by 연결이 다른 출력을 무효화: " + oid
            )


def _export_refs(p):
    """Direct input refs for export publish/resume fingerprints.

    All sources/facts/sections stay, and so do outputs judged ``current``
    or ``invalid`` by ``output_lineage`` — stale flags, filenames, and
    dates never decide.  Only valid ``history`` outputs leave the direct
    set; ``fingerprint`` still resolves them recursively whenever a
    kept node's ``depends_on``/``target_refs`` points at them.
    """
    lineage = output_lineage(p)
    return [
        {"collection": collection, "id": key}
        for collection in ("sources", "facts", "sections", "outputs")
        for key in sorted(p[collection])
        if collection != "outputs" or lineage[key]["state"] != "history"
    ]


def _finance_check_items(p):
    """Select provided 천원 facts for the body crosscheck.

    ``sections[].claims`` selects the checked facts only when every section
    carries an explicit claims list; a mixed or unregistered project falls
    back to checking all facts so nothing is dropped silently.  An
    all-empty claims set cannot switch the check off — it blocks instead.
    ``sources[].claims`` are source claims, not body claims, and are never
    consulted here.  Returns (items, blocked_reason).
    """
    def provided(fid):
        f = p["facts"][fid]
        return f.get("answer_state") == "provided" and f.get("value") is not None

    def eligible(fid):
        return provided(fid) and p["facts"][fid].get("unit") == "천원"

    def unsupported_money(fid):
        unit = p["facts"][fid].get("unit")
        return provided(fid) and isinstance(unit, str) and "원" in unit and unit != "천원"

    def item(fid):
        f = p["facts"][fid]
        return {
            "fact_id": fid,
            "field_id": f["field_id"],
            "value": f["value"],
            "unit": f.get("unit"),
            "period": f.get("period"),
            "scope": f.get("scope"),
        }

    sections = p.get("sections", {})
    complete = bool(sections) and all(
        isinstance(s.get("claims"), list) for s in sections.values()
    )
    eligible_ids = [fid for fid in p["facts"] if eligible(fid)]
    if not complete:
        return [item(fid) for fid in eligible_ids], None
    if not p["facts"]:
        return [], None
    claimed = list(
        dict.fromkeys(
            c["fact_id"]
            for s in sections.values()
            for c in s["claims"]
            if isinstance(c, dict) and c.get("fact_id") in p["facts"]
        )
    )
    if not claimed:
        if eligible_ids:
            return [], "모든 절의 본문 주장(claims)이 빈 목록: 재무 본문 대조 불가"
        return [], None
    return [item(fid) for fid in claimed if eligible(fid)], None


def _finance_unsupported_units(p):
    """Provided money facts (unit contains 원) that the 천원-only crosscheck cannot read."""
    out = []
    for fid, f in p.get("facts", {}).items():
        unit = f.get("unit")
        if (
            f.get("answer_state") == "provided"
            and f.get("value") is not None
            and isinstance(unit, str)
            and "원" in unit
            and unit != "천원"
        ):
            out.append((fid, unit))
    return out


def checks(root, p):
    from gg_document import parse

    out = []

    def add(cid, target, reason, severity="error", status="fail"):
        out.append(result(cid, target, status, reason, p["revision"], severity))

    for sid, s in p["sources"].items():
        try:
            if digest(local(root, s["path"]).read_bytes()) != s["hash"]:
                add("source_hash", sid, "원자료 변경: 재검토 필요")
        except (OSError, ValueError):
            add("source_missing", sid, "원자료 읽기 실패", status="blocked")
    for fid, f in p["facts"].items():
        for ref in f["source_refs"]:
            s = p["sources"].get(ref["id"])
            if s is None:
                add(
                    "source_ref_missing",
                    fid,
                    "원자료 참조 기록 없음: " + str(ref.get("id")),
                    status="blocked",
                )
                continue
            if ref.get("revision") != s["revision"]:
                add("source_revision", fid, "근거 개정 불일치")
            claims = s.get("claims")
            if claims is None:
                claims = {}
            if not isinstance(claims, dict):
                add(
                    "source_claims_invalid",
                    ref["id"],
                    "원자료 claims는 객체여야 함",
                    status="blocked",
                )
                continue
            claim = claims.get(ref.get("claim_id"))
            if f["kind"] != "derived" and f["answer_state"] == "provided":
                if claim is None:
                    add(
                        "claim_missing",
                        fid,
                        "원문 대조값 없음: 의미 검토 필요",
                        status="blocked",
                    )
                elif any(
                    f[k] != claim.get(k)
                    for k in (
                        "field_id",
                        "value",
                        "unit",
                        "period",
                        "scope",
                        "answer_state",
                        "kind",
                    )
                ):
                    add(
                        "claim_mismatch",
                        fid,
                        "항목·값·단위·기간·범위·사실 종류 원문 불일치",
                    )
            if f["verification"] == "claim_supported" and not s.get("claim_review"):
                add(
                    "claim_review",
                    fid,
                    "자료 실재만으로 주장 검증 불가",
                    status="blocked",
                )
        if f["kind"] == "derived":
            try:
                refs = f["input_refs"]
                vals = []
                for ref in refs:
                    v = p["facts"][ref["id"]]
                    if ref["revision"] != v["revision"]:
                        raise ValueError("계산 입력 개정 불일치")
                    vals.append(Decimal(v["value"]))
                op = f["formula"]["op"]
                if op == "convert":
                    factors = {
                        ("kg", "g"): "1000",
                        ("g", "kg"): ".001",
                        ("천원", "원"): "1000",
                        ("10a", "㎡"): "1000",
                        ("%", "ratio"): ".01",
                    }
                    src = p["facts"][refs[0]["id"]]
                    if src["period"] != f["period"] or src["scope"] != f["scope"]:
                        raise ValueError("환산으로 기간/범위를 바꿀 수 없음")
                    value = vals[0] * Decimal(factors[(src["unit"], f["unit"])])
                elif op in {"multiply", "divide", "add", "subtract"}:
                    if len(vals) != 2 or not f["formula"].get("unit_reason"):
                        raise ValueError("이항 산식/단위 근거 필요")
                    a, b = vals
                    if op == "multiply":
                        value = a * b
                    elif op == "divide":
                        value = a / b
                    elif op == "add":
                        value = a + b
                    else:
                        value = a - b
                else:
                    raise ValueError("미지원 산식")
                if value != Decimal(f["value"]):
                    raise ValueError("계산 결과 불일치")
            except (
                KeyError,
                ValueError,
                InvalidOperation,
                ArithmeticError,
                TypeError,
            ) as e:
                add("calculation", fid, str(e))
    for sid, s in p["sections"].items():
        try:
            raw = local(root, s["path"]).read_text(encoding="utf-8")
            text = draft(raw)
            extra = draft_marker_extra(raw)
            if extra:
                add(
                    "draft_marker_extra",
                    sid,
                    "DRAFT 마커 밖 원문이 병합·검사에 보이지 않음(원본 보존·대조 필요): "
                    + extra[:60],
                )
            if digest(text) != s["draft_hash"]:
                add("draft_changed", sid, "본문 수동 변경: 재등록·재검토 필요")
            if not any(n["kind"] in {"paragraph", "table"} for n in parse(text)):
                add(
                    "content_incomplete",
                    sid,
                    "본문 미작성 또는 제목·객체만 존재: 내용검토와 필수항목 대조 필요",
                )
            for c in s.get("claims", []):
                f = p["facts"][c["fact_id"]]
                if c.get("quote") not in text or not c.get("quote"):
                    add("claim_location", sid, "주장 본문 위치 없음")
                if f["answer_state"] != "provided" or any(
                    c.get(k) != f[k]
                    for k in ("value", "unit", "period", "scope", "kind", "field_id")
                ):
                    add("draft_claim", sid, "본문 주장의 사실·상태·기간 불일치")
            for dep in s.get("depends_on", []):
                if node(p, dep)["revision"] != dep["revision"]:
                    add("dependency_revision", sid, "절 의존 개정 불일치")
        except (OSError, KeyError, ValueError) as e:
            add("section", sid, str(e), status="blocked")
    for rid, rule in p["rules"].items():
        guideline_ids = set()
        profile_rule = p["rules"].get("guideline_profile")
        if isinstance(profile_rule, dict) and isinstance(profile_rule.get("requirement_ids"), list):
            guideline_ids = {x for x in profile_rule["requirement_ids"] if isinstance(x, str)}
        if rid == "guideline_profile" or rid in guideline_ids:
            continue
        refs = rule.get("source_refs", [])
        if not refs or any(
            r.get("id") not in p["sources"]
            or not r.get("locator")
            or r.get("revision") != p["sources"][r["id"]]["revision"]
            for r in refs
        ):
            add(
                "rule_source",
                rid,
                "학교 규칙 원문·위치·개정 근거 필요",
                status="blocked",
            )
        if rid == "output_formats":
            continue
        if rule.get("applicable") is False:
            condition = rule.get("applies_when", {})
            fact = p["facts"].get(condition.get("fact_id"), {})
            if (
                not rule.get("na_reason")
                or not rule.get("depends_on")
                or condition.get("operator") != "equals"
                or condition.get("revision") != fact.get("revision")
                or fact.get("answer_state") != "provided"
                or "value" not in condition
                or fact.get("value") == condition["value"]
            ):
                add("rule_na", rid, "해당 없음 적용 조건·사실 개정·평가 근거 필요")
        elif rule.get("applicable") is not True or not rule.get("locations"):
            add(
                "rule_coverage",
                rid,
                "학교 요구의 적용 여부/본문 위치 미확인",
                status="blocked",
            )
        else:
            for location in rule["locations"]:
                try:
                    body = draft(
                        local(
                            root, p["sections"][location["section_id"]]["path"]
                        ).read_text(encoding="utf-8")
                    )
                    if not location.get("quote") or location["quote"] not in body:
                        raise ValueError("적용 근거 본문 인용 없음")
                except (OSError, KeyError, ValueError, TypeError) as e:
                    add("rule_location", rid, str(e), status="blocked")
    # Guideline coverage is a separate source-bound runtime check.  Generic
    # projects remain usable without a school profile; selecting an official
    # school source without one is fail-closed.
    try:
        from gg_guidelines import check as guideline_check

        guideline_report = guideline_check(root, p)
        gstatus = guideline_report.get("status")
        if gstatus == "not_configured":
            out.append(
                result(
                    "guideline_profile",
                    "project",
                    "not_configured",
                    guideline_report.get("reason") or "학교 지침 프로필 미설정(일반 프로젝트)",
                    p["revision"],
                    severity="warning",
                    required_for=[],
                )
            )
        else:
            ready = guideline_report.get("guideline_ready") is True
            out.append(
                result(
                    "guideline_profile",
                    "project",
                    "pass" if ready else "blocked",
                    "지침 항목별 근거·검토 결합" if ready else (guideline_report.get("reason") or "지침 항목별 검증 근거 누락"),
                    p["revision"],
                    severity="warning" if ready else "error",
                    evidence=[{"status": gstatus, "blockers": guideline_report.get("blockers", []), "inventory": guideline_report.get("inventory", {})}],
                    required_for=[] if ready else ["submission_candidate"],
                )
            )
            for item in guideline_report.get("items", []):
                if item.get("status") == "blocked":
                    out.append(
                        result(
                            "guideline_item:" + str(item.get("id")),
                            "guidelines",
                            "blocked",
                            item.get("reason") or "지침 항목 검증 근거 누락",
                            p["revision"],
                            severity="error",
                        )
                    )
                elif item.get("status") == "pending" and item.get("kind") == "user_finish":
                    out.append(
                        result(
                            "guideline_item:" + str(item.get("id")),
                            "user_finish",
                            "pending",
                            item.get("reason") or "사용자 지침 마무리 확인 필요",
                            p["revision"],
                            severity="warning",
                            owner="user",
                            required_for=["user_finish"],
                        )
                    )
    except (ImportError, OSError, ValueError, KeyError, TypeError) as e:
        out.append(result("guideline_runtime", "project", "blocked", str(e), p["revision"]))
    if not p["rules"]:
        add("school_profile", "project", "학교 규칙 미등록", status="blocked")
    try:
        import gg_document

        # CONTENT_REVIEW_HINTS is owned by Devin B (gg_document.py); core only
        # reads it and only these three lexical-hint ids may become warnings.
        hint_ids = getattr(gg_document, "CONTENT_REVIEW_HINTS", ())
        if isinstance(hint_ids, (set, frozenset, list, tuple)):
            hint_ids = set(hint_ids) & {
                "intro_topics",
                "closing_elements",
                "process_plan",
            }
        else:
            hint_ids = set()
        for cid, reason in gg_document.check(merged(root, p), root):
            add(cid, "body", reason,
                severity="warning" if cid in hint_ids else "error")
        lineage = output_lineage(p)
        for oid, verdict in lineage.items():
            if verdict["state"] == "invalid":
                add(
                    "output_superseded_by",
                    oid,
                    verdict["reason"],
                    status="blocked",
                )
        from gg_school_excel import inspect_outputs

        for cid, reason in inspect_outputs(root, p, lineage):
            add(cid, "xlsx", reason)
        body = merged(root, p)
        for fid, unit in _finance_unsupported_units(p):
            add(
                "body_finance_crosscheck",
                fid,
                "미지원 단위(%s): 자동 대조는 천원만 지원, 본문 수치를 수동 확인해야 함" % unit,
                status="blocked",
            )
        items, claims_block = _finance_check_items(p)
        if claims_block:
            add("body_finance_crosscheck", "body", claims_block, status="blocked")
        elif items:
            from gg_school_excel import crosscheck_body

            for item in crosscheck_body(body, items):
                add(
                    "body_finance_crosscheck",
                    item.get("fact_id") or item["location"],
                    item["reason"],
                )
    except (OSError, ValueError, KeyError, ImportError) as e:
        add("document_parse", "body", str(e), status="blocked")
    views = p.get("views")
    if views is None:
        views = {}
    if not isinstance(views, dict):
        add("view_invalid", "views", "views는 객체여야 함", status="blocked")
        views = {}
    for name, v in views.items():
        try:
            if digest(local(root, name).read_bytes()) != v["hash"]:
                add(
                    "view_edited",
                    name,
                    "생성 보기 수동 변경: 원본을 보존하고 대조해야 함",
                )
        except ValueError as e:
            add("view_invalid", name, str(e), status="blocked")
        except OSError:
            add("view_missing", name, "보기 생성 실패/누락", status="blocked")
    return out or [
        result(
            "structure",
            "project",
            "pass",
            "등록 데이터 일관성만 확인; 내용/출력 검토 별도",
            p["revision"],
        )
    ]


def ingest_review_observation(root, observation, observer):
    """Stamp an adapter observation. Not an OS-user authentication boundary."""
    if not isinstance(observer, str) or not observer.strip():
        raise ValueError("관측 어댑터 ID 필요")
    if not isinstance(observation, dict):
        raise ValueError("관측 기록은 객체여야 함")
    recorded = copy.deepcopy(observation)
    recorded["schema"] = "gg-review-observation/1"
    recorded["observed_by"] = observer.strip()
    for key in ("review_kinds", "author_session", "reviewer_session", "author_id", "reviewer_id", "target_refs", "input_fingerprint", "report_hash"):
        if key not in recorded or recorded[key] in (None, "", [], {}):
            raise ValueError("관측 기록 필수 필드 누락: " + key)
    if not isinstance(recorded["review_kinds"], list):
        raise ValueError("관측 검토 종류는 목록이어야 함")
    if recorded["author_session"] == recorded["reviewer_session"]:
        raise ValueError("자기 세션 관측은 기록할 수 없음")
    if recorded["observed_by"] in {recorded["author_session"], recorded["reviewer_session"]}:
        raise ValueError("관측자가 당사자 세션이면 기록할 수 없음")
    payload = json.dumps(recorded, ensure_ascii=False, sort_keys=True).encode()
    digest_hex = digest(payload)
    relative = ".gg-observations/" + digest_hex + ".json"
    path = local(root, relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError("관측 기록 충돌")
        return {"path": relative, "hash": digest_hex}
    atomic(path, payload)
    return {"path": relative, "hash": digest_hex}


def review_observation_state(root, review):
    """Return (state, reason) for a review's adapter observation.

    States: 'valid', 'legacy_unobserved' (no observation provenance was ever
    recorded; such reviews are not invalidated wholesale), 'invalid' (the
    provenance exists but is broken; the reason carries the cause).
    """
    if not review.get("provenance_path") and not review.get("provenance_hash"):
        return "legacy_unobserved", "관측 파일이 없는 레거시 독립검토"
    try:
        relative = Path(review["provenance_path"])
        if (
            relative.parts != (".gg-observations", relative.name)
            or not relative.name.endswith(".json")
        ):
            return (
                "invalid",
                "관측 파일이 관측 저장소 밖: " + str(review["provenance_path"]),
            )
        data = local(root, review["provenance_path"]).read_bytes()
        if digest(data) != review["provenance_hash"]:
            return "invalid", "관측 기록 해시 불일치"
        try:
            observation = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            return "invalid", "관측 기록 JSON 손상: " + str(error)
        if not isinstance(observation, dict):
            return "invalid", "관측 기록이 객체 아님"
        if observation.get("schema") != "gg-review-observation/1":
            return "invalid", "관측 스키마 불일치"
        if (
            not isinstance(observation.get("review_kinds"), list)
            or review["review_kind"] not in observation["review_kinds"]
        ):
            return "invalid", "관측 검토 종류 불일치"
        for key in (
            "observed_by", "author_session", "reviewer_session",
            "author_id", "reviewer_id",
        ):
            if not isinstance(observation.get(key), str) or not observation[key].strip():
                return "invalid", "관측 식별자 누락: " + key
        if observation["author_session"] == observation["reviewer_session"]:
            return "invalid", "자기 세션 관측"
        if observation["observed_by"] in {
            observation["author_session"], observation["reviewer_session"],
        }:
            return "invalid", "관측자가 당사자 세션"
        for key in (
            "author_id", "reviewer_id", "target_refs",
            "input_fingerprint", "report_hash",
        ):
            if observation.get(key) != review.get(key):
                return "invalid", "관측·검토 기록 불일치: " + key
        return "valid", ""
    except (KeyError, OSError, ValueError, TypeError, AttributeError) as error:
        return (
            "invalid",
            "관측 기록 확인 실패: " + type(error).__name__ + ": " + str(error),
        )


def review_observation_valid(root, review):
    """Match adapter observations; this is not an OS-user authentication boundary."""
    return review_observation_state(root, review)[0] == "valid"


def gate(root, p):
    out = checks(root, p)
    content_covered = set()
    for f in p["facts"].values():
        if f["answer_state"] == "provided" and f["verification"] != "claim_supported":
            out.append(
                result(
                    "fact_unreviewed",
                    f["id"],
                    "blocked",
                    "주장 적합성 검토 미완료",
                    p["revision"],
                )
            )
    for kind in ("content", "logic", "calculation", "docx", "xlsx", "render"):
        valid = []
        causes = []
        for r in p["reviews"].values():
            try:
                state, obs_reason = review_observation_state(root, r)
                if state == "invalid":
                    causes.append(obs_reason)
                if (
                    r["review_kind"] == kind
                    and r["status"] == "pass"
                    and not r.get("stale")
                    and r["author_id"] != r["reviewer_id"]
                    and state != "invalid"
                    and r["disposition"] == "resolved"
                    and r["input_fingerprint"] == fingerprint(root, p, r["target_refs"])
                    and digest(local(root, r["path"]).read_bytes()) == r["report_hash"]
                    and r.get("target_refs")
                    and r.get("coverage")
                    and isinstance(r.get("findings"), list)
                    and all(isinstance(x, dict) for x in r["findings"])
                    and not any(
                        x.get("severity") == "error" and x.get("status") != "resolved"
                        for x in r["findings"]
                    )
                ):
                    if state == "legacy_unobserved":
                        r["observation"] = "legacy_unobserved"
                    valid.append(r)
                    if kind == "content":
                        content_covered.update(
                            x["id"]
                            for x in r["target_refs"]
                            if x["collection"] == "sections"
                        )
            except (KeyError, OSError, ValueError, TypeError, AttributeError):
                pass
        if not valid:
            reason = "현재 버전의 독립 검토와 위치별 근거 필요"
            if causes:
                reason += " (" + "; ".join(dict.fromkeys(causes)) + ")"
            out.append(
                result(
                    "review_" + kind,
                    "project",
                    "blocked",
                    reason,
                    p["revision"],
                )
            )
    legacy_reviews = sorted(
        r["id"]
        for r in p["reviews"].values()
        if r.get("observation") == "legacy_unobserved"
    )
    if legacy_reviews:
        out.append(
            result(
                "review_observation",
                "project",
                "blocked",
                "관측 없는 레거시 검토라 제출 후보 불가: " + ", ".join(legacy_reviews),
                p["revision"],
            )
        )
    # Missing sections or unreviewed prose must never pass based on a handful of review flags.
    if not p["sections"] or set(p["sections"]) - content_covered:
        out.append(
            result(
                "coverage",
                "project",
                "blocked",
                "모든 절의 내용검토 필요",
                p["revision"],
            )
        )
    profile = p["rules"].get("output_formats", {})
    formats = profile.get("formats", [])
    if (
        not formats
        or not profile.get("source_refs")
        or not set(formats) <= {"docx", "xlsx", "hwp"}
    ):
        out.append(
            result(
                "output_profile",
                "project",
                "blocked",
                "근거에 연결된 최종 제출 형식 미확정",
                p["revision"],
            )
        )
    lineage = output_lineage(p)
    for fmt in formats:
        required = {
            "docx": {"structure", "font", "render"},
            "xlsx": {"structure", "recalculation", "crosscheck", "render"},
            "hwp": {"reopen", "render", "crosscheck"},
        }.get(fmt)
        valid_output = False
        for oid, output in p["outputs"].items():
            try:
                if (
                    output.get("format") != fmt
                    or output.get("stale")
                    or not required
                    or lineage.get(oid, {}).get("state") != "current"
                ):
                    continue
                current_hash = digest(local(root, output["path"]).read_bytes())
                fp = fingerprint(root, p, output["target_refs"])
                covered_sections = {
                    r["id"]
                    for r in output["target_refs"]
                    if r["collection"] == "sections"
                }
                covered_facts = {
                    r["id"] for r in output["target_refs"] if r["collection"] == "facts"
                }
                if (
                    current_hash != output["file_hash"]
                    or fp != output["input_fingerprint"]
                    or set(p["sections"]) - covered_sections
                    or set(p["facts"]) - covered_facts
                ):
                    continue
                records = output.get("checks", [])
                if not isinstance(records, list) or any(
                    not isinstance(check, dict) for check in records
                ):
                    continue
                ids = [check.get("check_id") for check in records]
                # Conflicting/stale reruns cannot be hidden behind an earlier pass.
                if any(ids.count(cid) != 1 for cid in required):
                    continue
                passed = set()
                for check in records:
                    if (
                        check.get("status") == "pass"
                        and check.get("file_hash") == current_hash
                        and check.get("input_fingerprint") == fp
                        and check.get("evidence_path")
                        and check.get("check_id")
                        not in visual_review_blocks(local(root, check["evidence_path"]))
                        and check.get("evidence_hash")
                        == digest(local(root, check["evidence_path"]).read_bytes())
                    ):
                        passed.add(check.get("check_id"))
                if required <= passed:
                    valid_output = True
                    out.append(
                        result(
                            "output_" + fmt,
                            output["id"],
                            "pass",
                            "현재 출력 파일의 필수 검사·증거 일치",
                            p["revision"],
                            owner="user" if fmt == "hwp" else "skill",
                            required_for=["user_finish"] if fmt == "hwp" else None,
                        )
                    )
                    break
            except (KeyError, OSError, ValueError, TypeError, AttributeError):
                continue
        if not valid_output:
            out.append(
                result(
                    "output_" + fmt,
                    "project",
                    "blocked",
                    "현재 파일 해시의 필수 출력검사·증거 누락/변경",
                    p["revision"],
                    owner="user" if fmt == "hwp" else "skill",
                    required_for=["user_finish"] if fmt == "hwp" else None,
                )
            )
    out.extend(user_finish_checks(p, out))
    out.append(professor_approval_check(p, root))
    return out


def blocks_skill_candidate(check):
    return (
        check["status"] != "pass"
        and check["severity"] == "error"
        and check.get("owner", "skill") == "skill"
    )


def user_finish_checks(p, report):
    hwp_pass = any(
        x["check_id"] == "output_hwp" and x["status"] == "pass" for x in report
    )
    return [
        result(
            item["id"],
            "user_finish",
            "blocked",
            item["reason"],
            p["revision"],
            owner="user",
            required_for=["user_finish"],
        )
        for item in user_finish_task_list(p)
        if item["id"] != "hwp_convert" or not hwp_pass
    ]


def professor_approval_check(p, root=None):
    recorded = False
    outputs = p.get("outputs") or {}
    try:
        lineage = output_lineage(p)
        current = {
            oid
            for oid, verdict in lineage.items()
            if verdict["state"] == "current"
        }
        degraded = any(
            verdict["state"] == "invalid"
            or (verdict["state"] == "current" and outputs[oid].get("stale"))
            for oid, verdict in lineage.items()
        )
    except (TypeError, AttributeError, KeyError):
        current, degraded = set(), True
    for approval in p.get("approvals", {}).values():
        try:
            if (
                root is not None
                and current
                and not degraded
                and approval.get("kind") == "professor"
                and approval.get("status") == "confirmed"
                and not approval.get("stale")
                and approval.get("evidence_path")
                and approval.get("scope") == "project_outputs"
                and {
                    (ref["collection"], ref["id"])
                    for ref in approval.get("target_refs", [])
                } == {("outputs", key) for key in current}
                and approval.get("human_confirmation", {}).get("explicit") is True
                and approval["human_confirmation"].get("confirmed_by")
                and approval.get("registered_revision") == p["revision"]
                and approval.get("input_revision") == p["revision"] - 1
                and approval.get("target_refs")
                and approval.get("input_fingerprint")
                == fingerprint(root, p, approval["target_refs"])
                and approval.get("evidence_hash")
                == digest(local(root, approval["evidence_path"]).read_bytes())
            ):
                recorded = True
                break
        except (TypeError, AttributeError, KeyError, OSError, ValueError):
            continue
    return result(
        "professor_approval",
        "project",
        "pass" if recorded else "blocked",
        "교수 승인 기록 확인" if recorded else "교수 승인 근거 미기록",
        p["revision"],
        owner="professor",
        required_for=["professor_approval"],
    )


def completion(root, p, report=None):
    report = list(report if report is not None else gate(root, p))
    user_items = [
        {
            "id": x["check_id"],
            "status": "needs_user",
            "owner": "user",
            "reason": x["reason"],
        }
        for x in report
        if x.get("owner") == "user"
        and x.get("target") == "user_finish"
        and x["status"] != "pass"
    ]
    professor = next(
        (x for x in report if x["check_id"] == "professor_approval"),
        None,
    )
    return {
        "skill_ready": not any(blocks_skill_candidate(x) for x in report),
        "guideline_ready": next(
            (
                None
                if x.get("status") == "not_configured"
                else x.get("status") == "pass"
                for x in report
                if x.get("check_id") == "guideline_profile"
            ),
            None,
        ),
        "user_finish_pending": user_items,
        "professor_approval_pending": not (professor and professor["status"] == "pass"),
        "notice": "스킬 Ⅰ~Ⅵ 작성·DOCX/XLSX 검사 완료와 한글 마무리·교수 승인은 별개다. 사용자 미완료를 자동 통과·N/A하지 않는다.",
    }


def merged(root, p):
    parts = []
    for s in sorted(p["sections"].values(), key=lambda x: x["order"]):
        body = draft(local(root, s["path"]).read_text(encoding="utf-8"))
        title = s["title"]
        parts.append(
            body
            if body.splitlines() and body.splitlines()[0].lstrip("# ") == title
            else title + "\n\n" + body
        )
    return "\n\n".join(parts)


def export(root, kind):
    with Lock(root):
        return export_locked(root, kind)


def publish_export(staging, folder, manifest):
    directory = _DirRef(folder)
    try:
        directory.stat(".publication.json")
        if not _same_marker(folder / ".publication.json", staging / ".publication.json"):
            raise ValueError("발행 목적지 소유권 변경")
        for name in [*manifest["files"], "manifest.json"]:
            source = local(staging, name)
            destination = local(folder, name)
            if destination.exists():
                same = False
                try:
                    same = source.samefile(destination)
                except OSError:
                    same = False
                if not same and digest(source.read_bytes()) != digest(destination.read_bytes()):
                    raise ValueError("부분 산출물 소유권/파일 변경: 복구 중단")
                continue
            directory.link(source, name)
        directory.fsync()
        current = os.lstat(folder)
        if (current.st_dev, current.st_ino) != directory.identity():
            raise ValueError("발행 중 목적지 교체: 성공으로 등록하지 않음")
    finally:
        directory.close()


def export_locked(root, kind):
    p = load(root)
    report = gate(root, p)
    if kind == "submission_candidate":
        blocking = [x for x in report if blocks_skill_candidate(x)]
        if blocking:
            reasons = []
            for check in blocking:
                if check["reason"] not in reasons:
                    reasons.append(check["reason"])
            raise ValueError("제출 후보 차단: " + "; ".join(reasons))
    label = {
        "draft": "검토전_초안",
        "review": "검토용",
        "submission_candidate": "검사완료_교수확인전",
    }[kind]
    folder = local(root, "build/" + str(p["revision"]) + "/" + kind)
    if export_complete(folder, kind, p["revision"]):
        raise ValueError("기존 산출물을 덮어쓰지 않음")
    owner_path = folder / ".publication.json"
    if owner_path.is_file():
        try:
            owner = json.loads(owner_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            owner = None
        refs = _export_refs(p)
        current_fingerprint = fingerprint(root, p, refs)
        staging = None
        if isinstance(owner, dict) and isinstance(owner.get("stage"), str):
            try:
                staging = local(folder.parent, owner["stage"])
            except ValueError:
                staging = None
        # The staging marker may already be gone (interrupted cleanup). Check
        # existence before samefile so a missing marker never raises here.
        stage_marker = (
            staging / ".publication.json" if staging is not None else None
        )
        stage_marker_ok = False
        if staging is not None and staging.name.startswith(".gg-export-"):
            try:
                stage_marker_ok = _same_marker(owner_path, stage_marker)
            except OSError:
                # Marker vanished between the check and the compare: not ours.
                stage_marker_ok = False
        stage_missing = staging is None or not staging.exists() or (
            staging.is_dir() and not any(staging.iterdir())
        )
        owner_files = owner.get("files") if isinstance(owner, dict) else None
        present = {
            path.name: path
            for path in folder.iterdir()
            if path.name != ".publication.json"
        }
        # Every present payload file must be declared and unchanged, every
        # declared payload file must be present, and nothing unexplained may
        # remain in the folder (a bare leftover like .DS_Store must deadlock
        # loudly instead of silently passing or blocking recovery).
        payload_ok = (
            isinstance(owner_files, dict)
            and set(present) == set(owner_files)
            and all(
                digest(path.read_bytes()) == owner_files[name]
                for name, path in present.items()
            )
        )
        # Resuming an interrupted publish tolerates declared files that are
        # still missing (the interruption hit before they were linked) but
        # never a file the owner record cannot explain; anything unexplained
        # must deadlock loudly instead of riding into the publication.
        payload_subset_ok = isinstance(owner_files, dict) and all(
            name in owner_files and digest(path.read_bytes()) == owner_files[name]
            for name, path in present.items()
        )
        if (
            isinstance(owner, dict)
            and stage_marker_ok
            and payload_subset_ok
            and owner.get("project_hash") == digest(p)
            and owner.get("input_fingerprint") == current_fingerprint
            and export_complete(staging, kind, p["revision"])
        ):
            manifest = json.loads((staging / "manifest.json").read_text(encoding="utf-8"))
            publish_export(staging, folder, manifest)
            shutil.rmtree(staging)
            return str(folder / (label + ".md"))
        if (
            isinstance(owner, dict)
            and isinstance(owner.get("token"), str)
            and owner.get("token")
            and owner.get("project_hash") == digest(p)
            and owner.get("input_fingerprint") == current_fingerprint
            and payload_ok
            and (stage_marker_ok or stage_missing)
        ):
            # Self-owned incomplete publication: archive the leftover folder
            # under an incomplete-<ts> name and republish from staging; never
            # delete the previous destination with rmtree.
            archived = folder.with_name(
                folder.name + ".incomplete-" + time.strftime("%Y%m%dT%H%M%S")
            )
            if archived.exists():
                raise ValueError("불완전 발행 보관 이름 충돌: " + archived.name)
            folder.rename(archived)
        else:
            raise ValueError("부분 발행의 소유권·입력·준비본 불일치")
    parent = folder.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".gg-export-", dir=parent))
    reserved = False
    try:
        local(root, str(staging.relative_to(Path(root).resolve())))
        body = merged(root, p)
        # 절이 하나도 없거나 모든 절의 초안이 비어 있으면 merged() 는 빈 문자열을
        # 돌려준다. 그대로 쓰면 0바이트 파일이 생기고 호출자는 경로를 돌려받아
        # "완료"로 읽는다 — 하지 않은 일을 했다고 말하는 것이므로 여기서 멈춘다.
        if not body.strip():
            raise ValueError(
                "내보낼 본문이 없음: 등록된 절이 없거나 모든 절의 초안이 비어 있음"
            )
        path = staging / (label + ".md")
        atomic(path, body.encode())
        state = completion(root, p, report)
        manifest = {
            "kind": kind,
            "revision": p["revision"],
            "professor_approval": "not_confirmed",
            "skill_ready": state["skill_ready"],
            "user_finish_pending": state["user_finish_pending"],
            "professor_approval_pending": state["professor_approval_pending"],
            "checks": report,
            "files": {path.name: digest(path.read_bytes())},
            "notice": state["notice"],
        }
        if kind == "submission_candidate":
            for check in report:
                if (
                    check["check_id"].startswith("output_")
                    and check["status"] == "pass"
                ):
                    output = p["outputs"][check["target"]]
                    data = local(root, output["path"]).read_bytes()
                    if digest(data) != output["file_hash"]:
                        raise ValueError("검사 후 출력 파일 변경: 제출 후보 무효")
                    name = "검사완료_교수확인전." + output["format"]
                    atomic(staging / name, data)
                    manifest["files"][name] = digest(data)
            if (
                load(root)["revision"] != p["revision"]
                or body != merged(root, p)
                or any(blocks_skill_candidate(x) for x in gate(root, p))
            ):
                raise ValueError("출력 중 입력 변경: 제출 후보 무효")
        atomic(
            staging / "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2).encode(),
        )
        if export_complete(folder, kind, p["revision"]):
            raise ValueError("기존 산출물을 덮어쓰지 않음")
        if folder.exists():
            raise ValueError("소유권 미확인 산출물 충돌: 기존 파일을 보존함")
        refs = _export_refs(p)
        atomic(staging / ".publication.json", json.dumps({
            "stage": staging.name,
            "project_hash": digest(p),
            "input_fingerprint": fingerprint(root, p, refs),
            "files": manifest["files"],
            "phase": "prepared",
            "token": uuid.uuid4().hex,
        }).encode())
        # Reserve exclusively; even an empty late-arriving destination is preserved.
        folder.mkdir()
        reserved = True
        reserved_dir = _DirRef(folder)
        try:
            reserved_dir.link(staging / ".publication.json", ".publication.json")
        finally:
            reserved_dir.close()
        publish_export(staging, folder, manifest)
        reserved = False
        return str(folder / (label + ".md"))
    finally:
        if staging is not None and not reserved:
            try:
                shutil.rmtree(staging)
            except OSError:
                # Do not mask a finished publication; make the leftover loud
                # and predictable instead of silently ignoring it.
                stale = staging.with_name(staging.name + '-stale-' + uuid.uuid4().hex[:8])
                try:
                    staging.rename(stale)
                except OSError:
                    pass


def export_complete(folder, kind, revision):
    manifest = Path(folder) / "manifest.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        files = data["files"]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    if (
        data.get("kind") != kind
        or data.get("revision") != revision
        or not isinstance(files, dict)
        or not files
    ):
        return False
    try:
        return all(
            digest((Path(folder) / name).read_bytes()) == digest_value
            for name, digest_value in files.items()
        )
    except OSError:
        return False


def migrate(src, dest):
    src, dest = Path(src).resolve(), Path(dest).resolve()
    if dest.exists() or dest.is_relative_to(src) or src.is_relative_to(dest):
        raise ValueError("마이그레이션은 겹치지 않는 새 폴더에만 가능")
    if (src / "project.json").exists():
        raise ValueError("이미 새 형식: import 대신 status 사용")
    if not src.is_dir() or (src / "migration").exists() or (src / ".gg-lock").exists():
        raise ValueError("원본 폴더·기존 migration·쓰기 잠금 확인 필요")
    before = migration_inventory(src)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Publish only after all preservation checks and the state transaction succeed.
    # A hard kill can leave staging or an empty reservation, never an approved project.
    with tempfile.TemporaryDirectory(prefix=".gg-import-", dir=dest.parent) as tmp:
        staged = Path(tmp) / "workspace"
        shutil.copytree(
            src,
            staged,
            ignore=shutil.ignore_patterns(".work", ".git", "__pycache__"),
            symlinks=True,
        )
        if migration_inventory(staged) != before or migration_inventory(src) != before:
            raise ValueError("복사 중 원본 변경: 원본을 대조한 뒤 재시도")
        p = migrate_staged(staged, before)
        if migration_inventory(src) != before:
            raise ValueError("변환 중 원본 변경: 원본을 대조한 뒤 재시도")
        # Exclusive reservation prevents replacing another import/user workspace.
        dest.mkdir()
        try:
            if _DIR_RENAME_REPLACES:
                os.replace(staged, dest)
            else:
                # Windows rename cannot target an existing directory, not even an
                # empty one. Release the reservation immediately before the move;
                # os.rename still refuses to overwrite, so a racing creation is
                # reported instead of silently replaced.
                dest.rmdir()
                os.rename(staged, dest)
        except OSError:
            if dest.is_dir() and not any(dest.iterdir()):
                dest.rmdir()  # Only the empty directory reserved above; never recursive.
            raise
        return p


def migration_inventory(root):
    inventory = {}
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in {".work", ".git", "__pycache__"})
        for name in dirs + sorted(names):
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(
                    "마이그레이션은 심볼릭 링크를 따라가지 않음: "
                    + str(path.relative_to(root))
                )
            if path.is_file():
                inventory[str(path.relative_to(root))] = digest(path.read_bytes())
            elif not path.is_dir():
                raise ValueError(
                    "일반 파일/폴더가 아닌 원본: " + str(path.relative_to(root))
                )
    return inventory


def migrate_staged(dest, inventory):
    init(dest)
    ops, comparison, inputs, issues = [], [], [], []
    receipt_ids, field_values = {}, {}
    # Index verbatim originals, never treat old 'verified' strings as new approval.
    # Free-form interviews/assumptions stay source records until explicit field mapping.
    for name, original_hash in sorted(inventory.items()):
        path = local(dest, name)
        section = Path(name).parent == Path("sections") and path.suffix == ".md"
        source_path = "migration/original-sections/" + path.name if section else name
        sid = "legacy:" + name
        ops.append(
            {
                "collection": "sources",
                "value": dict(
                    id=sid,
                    path=source_path,
                    legacy=True,
                    verification="unreviewed",
                    original_path=name,
                ),
            }
        )
        entry = dict(
            path=name,
            preserved_path=source_path,
            original_hash=original_hash,
            status="unreviewed",
        )
        if path.suffix.lower() in {".md", ".txt", ".json", ".jsonl"}:
            try:
                text = path.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                issues.append(
                    dict(
                        code="legacy_encoding",
                        path=name,
                        reason="원본 바이트 보존; 텍스트 대조 보류",
                    )
                )
            else:
                entry["numeric_tokens"] = re.findall(r"[-+]?\d[\d,]*(?:\.\d+)?", text)
                entry["unresolved_lines"] = [
                    dict(line=i, text=line)
                    for i, line in enumerate(text.splitlines(), 1)
                    if "미결" in line or "미확정" in line or "[ ]" in line
                ]
                entry["absolute_path_lines"] = [
                    i
                    for i, line in enumerate(text.splitlines(), 1)
                    if re.search(r"/Users/|/home/|[A-Za-z]:[\\/]", line)
                ]
                if entry["absolute_path_lines"]:
                    issues.append(
                        dict(
                            code="legacy_path",
                            path=name,
                            lines=entry["absolute_path_lines"],
                            reason="이전 절대경로는 따라가지 않음; 현재 원문 위치 대조 필요",
                        )
                    )
                if path.suffix.lower() == ".jsonl":
                    entry["records"] = []
                    for line_number, line in enumerate(text.splitlines(), 1):
                        if not line.strip():
                            continue
                        record = dict(
                            line=line_number, raw=line, verification="unreviewed"
                        )
                        entry["records"].append(record)
                        try:
                            value = json.loads(line)
                            if not isinstance(value, dict):
                                raise ValueError("객체 아님")
                        except ValueError:
                            issues.append(
                                dict(
                                    code="legacy_record_invalid",
                                    path=name,
                                    line=line_number,
                                )
                            )
                            continue
                        record["legacy_value"] = value
                        rid = value.get("id")
                        if isinstance(rid, str):
                            if rid in receipt_ids:
                                issues.append(
                                    dict(
                                        code="legacy_duplicate_id",
                                        path=name,
                                        line=line_number,
                                        id=rid,
                                        previous=receipt_ids[rid],
                                    )
                                )
                            receipt_ids[rid] = dict(path=name, line=line_number)
                        field = value.get("field_id")
                        if isinstance(field, str) and "value" in value:
                            if (
                                field in field_values
                                and field_values[field] != value["value"]
                            ):
                                issues.append(
                                    dict(
                                        code="legacy_value_conflict",
                                        path=name,
                                        line=line_number,
                                        field_id=field,
                                    )
                                )
                            field_values[field] = value["value"]
                        if (
                            value.get("kind") in {"price", "stat", "calc"}
                            or "value" in value
                        ):
                            missing = [
                                k
                                for k in ("unit", "period", "scope")
                                if not value.get(k)
                            ]
                            if missing:
                                issues.append(
                                    dict(
                                        code="legacy_numeric_context",
                                        path=name,
                                        line=line_number,
                                        missing=missing,
                                    )
                                )
        inputs.append(entry)
    for i, path in enumerate(
        sorted((dest / "sections").glob("*.md"), key=lambda p: section_order(p.name))
    ):
        path = local(dest, path.relative_to(dest))
        text = path.read_text(encoding="utf-8")
        blocks = re.findall(
            r"^##\s+(INPUT|RESEARCH|FACTS|DRAFT|OPEN|STATUS)\b", text, re.M
        )
        if any(blocks.count(b) > 1 for b in set(blocks)) or (
            blocks and blocks.count("DRAFT") != 1
        ):
            raise ValueError("구형 절의 DRAFT/6블록 경계가 모호함: " + path.name)
        body = draft(text)
        saved = local(dest, "migration/original-sections/" + path.name)
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, saved)
        new = (
            text
            if START in text
            else re.sub(
                r"(^##\s+DRAFT[^\n]*\n)(.*?)(?=^##\s+(?:STATUS|INPUT|RESEARCH|FACTS|OPEN)\b|\Z)",
                lambda m: m[1] + START + "\n" + m[2].rstrip() + "\n" + END + "\n",
                text,
                flags=re.M | re.S,
            )
        )
        if START not in new:
            new = START + "\n" + text.rstrip() + "\n" + END + "\n"
        atomic(path, new.encode())
        preserved = body == draft(new)
        marker_extra = draft_marker_extra(new)
        if marker_extra:
            issues.append(
                dict(
                    code="legacy_marker_extra",
                    path=str(path.relative_to(dest)),
                    reason="DRAFT 마커 밖 원문은 병합·검사에 보이지 않음. 원본 보존; 대조 후 마커 안 이동 또는 제거 필요",
                    excerpt=marker_extra[:120],
                )
            )
        comparison.append(
            {
                "file": path.name,
                "body_preserved": preserved,
                "marker_extra": marker_extra is not None,
                "original_hash": inventory[str(path.relative_to(dest))],
                "preserved_path": str(saved.relative_to(dest)),
                "status": "legacy_unreviewed",
            }
        )
        if not preserved:
            raise ValueError("본문 보존 대조 실패")
        title = re.search(r"^#\s+(.+)$", text, re.M)
        ops.append(
            {
                "collection": "sections",
                "value": {
                    "id": path.stem,
                    "path": str(path.relative_to(dest)),
                    "title": title[1] if title else path.stem,
                    "order": i,
                    "status": "drafting",
                    "legacy": True,
                    "depends_on": [
                        {
                            "collection": "sources",
                            "id": "legacy:" + str(path.relative_to(dest)),
                            "revision": 1,
                        }
                    ],
                },
            }
        )
    atomic(
        local(dest, "migration/comparison.json"),
        json.dumps(comparison, ensure_ascii=False, indent=2).encode(),
    )
    for entry in inputs:
        if (
            digest(local(dest, entry["preserved_path"]).read_bytes())
            != entry["original_hash"]
        ):
            raise ValueError("원본 바이트 보존 대조 실패: " + entry["path"])
    report = dict(
        status="preserved_pending_semantic_mapping",
        inputs=inputs,
        issues=issues,
        section_count=len(comparison),
        source_count=len(inputs),
        promoted_facts=0,
        notice="원문·요약·수치 토큰·미결 항목을 보존함. 의미·단위·기간·충돌은 대조 후 정본 사실로 등록하며 기존 verified는 승격하지 않음.",
    )
    atomic(
        local(dest, "migration/inputs.json"),
        json.dumps(report, ensure_ascii=False, indent=2).encode(),
    )
    ops.append(
        {
            "collection": "sources",
            "value": dict(
                id="migration-report",
                path="migration/inputs.json",
                legacy=True,
                verification="unreviewed",
            ),
        }
    )
    ops.append(
        {
            "collection": "tasks",
            "value": dict(
                id="migration-review",
                required_fields=[],
                source_refs=[
                    dict(id="migration-report", revision=1, locator="inputs/issues")
                ],
                description="보존된 원답변·가정·증거를 먼저 읽고 사실 항목에 대조 등록. 재인터뷰나 기존 검증 승격 금지.",
            ),
        }
    )
    return apply(dest, {"request_id": "migration", "ops": ops}, 0)


def section_order(name):
    match = re.match(r"([IVX]+)(?:-(\d+))?", name)
    return (
        (
            {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6}.get(match[1], 99),
            int(match[2] or 0),
            name,
        )
        if match
        else (99, 0, name)
    )


# ---------------------------------------------------------------------------
# Lock inspection / recovery, lineage history, snapshot restore, doctor.
# Added for the audit fixes (C4, H10) and the companion GUI.


def _pid_alive(pid):
    """True/False when it can be decided on this host, None when unknown."""
    if type(pid) is not int or pid <= 0:
        return None
    if sys.platform == "win32":
        import ctypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            err = ctypes.get_last_error()
            if err == 87:  # ERROR_INVALID_PARAMETER: no such process
                return False
            return True  # access denied etc.: assume alive (conservative)
        try:
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == 259  # STILL_ACTIVE
            return True
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)  # POSIX: signal 0 only probes
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def lock_info(root):
    """Read-only description of <root>/.gg-lock. Never takes or alters the lock."""
    root = Path(root)
    lock = root / ".gg-lock"
    info = {
        "path": str(lock),
        "present": False,
        "owner": None,
        "owner_state": "missing",
        "host": socket.gethostname(),
        "host_matches": None,
        "pid_alive": None,
        "acquired_at": None,
        "age_seconds": None,
        "verdict": "none",
        "notice": "해제는 같은 기기에서 소유 프로세스가 종료된 경우에만 가능(자동 탈취 없음)",
    }
    try:
        lock.lstat()
    except FileNotFoundError:
        return info
    except OSError as error:
        info.update(present=True, owner_state="unreadable: " + str(error), verdict="ambiguous")
        return info
    info["present"] = True
    if lock.is_symlink() or not lock.is_dir():
        info.update(owner_state="not_a_directory", verdict="ambiguous")
        return info
    try:
        raw = (lock / "owner.json").read_bytes()
    except FileNotFoundError:
        info.update(owner_state="missing", verdict="ambiguous")
        return info
    except OSError as error:
        info.update(owner_state="unreadable: " + str(error), verdict="ambiguous")
        return info
    try:
        owner = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        owner = None
    if not isinstance(owner, dict):
        info.update(owner_state="corrupt", verdict="ambiguous")
        return info
    info["owner"] = owner
    info["owner_state"] = "ok"
    acquired = owner.get("acquired_at")
    if isinstance(acquired, (int, float)):
        info["acquired_at"] = acquired
        info["age_seconds"] = max(0, int(time.time() - acquired))
    info["host_matches"] = owner.get("host") == info["host"]
    if not info["host_matches"]:
        info["verdict"] = "foreign_host"
        return info
    alive = _pid_alive(owner.get("pid"))
    info["pid_alive"] = alive
    if alive is None:
        info["verdict"] = "ambiguous"
    elif alive:
        info["verdict"] = "live"
    else:
        info["verdict"] = "stale_releasable"
    return info


def unlock(root):
    """Release a stale lock: same host, owner process gone. Refuses everything else."""
    root = Path(root)
    lock = root / ".gg-lock"
    info = lock_info(root)
    if not info["present"]:
        raise ValueError("잠금 없음: 해제할 것이 없음")
    verdict = info["verdict"]
    if verdict == "live":
        raise ValueError(
            "잠금 해제 거부: 소유 프로세스(pid %s)가 아직 실행 중" % info["owner"].get("pid")
        )
    if verdict == "foreign_host":
        raise ValueError(
            "잠금 해제 거부: 다른 기기(%s)의 잠금은 그 기기에서 확인해야 함"
            % info["owner"].get("host")
        )
    if verdict != "stale_releasable":
        raise ValueError("잠금 해제 거부: 소유 기록이 불명확하여 보존함 (%s)" % info["owner_state"])
    owner_path = lock / "owner.json"
    again = json.loads(owner_path.read_bytes().decode("utf-8"))
    if again != info["owner"]:
        raise ValueError("잠금 소유 기록이 방금 바뀜: 해제 중단")
    owner_path.unlink()
    released = lock.with_name(".gg-tmp-lock-unlock-" + uuid.uuid4().hex)
    lock.rename(released)
    try:
        released.rmdir()
    except OSError:
        return {
            "released": True,
            "owner": info["owner"],
            "leftover": str(released),
            "notice": "잠금 디렉터리에 다른 파일이 남아 있어 이름만 바꿔 보존함",
        }
    return {"released": True, "owner": info["owner"], "leftover": None}


def history(root):
    """Lineage of project.json with snapshot availability. Read-only."""
    root = Path(root)
    p = load(root)
    out = []
    for h in p.get("history", []):
        rel = "migration/revision-%s.json" % h.get("revision")
        entry = dict(h, snapshot_path=rel, snapshot_ok=False)
        try:
            snap = json.loads(local(root, rel).read_text(encoding="utf-8"))
            entry["snapshot_ok"] = digest(snap) == h.get("hash")
        except (OSError, ValueError):
            pass
        out.append(entry)
    out.append(
        {
            "revision": p["revision"],
            "hash": digest(p),
            "request_id": None,
            "current": True,
            "snapshot_path": None,
            "snapshot_ok": None,
        }
    )
    return out


def restore(root, revision, expected_revision):
    """Bring project.json back to an earlier snapshot as a NEW revision.

    Section files, sources and build/ are untouched; only the ledger moves.
    The current state is snapshotted first so the operation itself is
    reversible through another restore.
    """
    root = Path(root)
    if type(revision) is not int or revision < 0:
        raise ValueError("복원할 개정 번호 필요")
    with Lock(root):
        p = load(root)
        if p["revision"] != expected_revision:
            raise ValueError("개정 충돌: 최신 정본을 다시 읽어야 함")
        if revision >= p["revision"]:
            raise ValueError("현재보다 앞선 개정만 복원할 수 있음")
        entry = next((h for h in p.get("history", []) if h.get("revision") == revision), None)
        if entry is None:
            raise ValueError("history에 없는 개정: %s" % revision)
        rel = "migration/revision-%s.json" % revision
        try:
            snap = json.loads(local(root, rel).read_text(encoding="utf-8"))
        except OSError as error:
            raise ValueError("스냅샷 읽기 실패: " + rel) from error
        if digest(snap) != entry.get("hash"):
            raise ValueError("스냅샷 해시 불일치: 복원 거부 (" + rel + ")")
        validate(snap)
        if snap.get("project_id") not in (None, p.get("project_id")):
            raise ValueError("다른 프로젝트의 스냅샷: 복원 거부")
        request = "restore:%s->%s" % (expected_revision, revision)
        if request in p["requests"]:
            raise ValueError("같은 복원을 이미 수행함")
        current_rel = local(root, "migration/revision-%s.json" % p["revision"])
        if current_rel.exists():
            existing = json.loads(current_rel.read_text(encoding="utf-8"))
            if digest(existing) != digest(p):
                raise ValueError("현재 개정 스냅샷이 이미 있고 내용이 다름: 복원 중단")
        atomic(current_rel, json.dumps(p, ensure_ascii=False, indent=2).encode())
        new = copy.deepcopy(snap)
        new["project_id"] = p.get("project_id") or snap.get("project_id")
        new["parent_hash"] = digest(p)
        new["history"] = list(p.get("history", [])) + [
            {"revision": p["revision"], "hash": new["parent_hash"], "request_id": request}
        ]
        new["requests"] = dict(p.get("requests", {}))
        new["revision"] = p["revision"] + 1
        new["requests"][request] = {"hash": digest({"restore": revision}), "revision": new["revision"]}
        for col in ("reviews", "approvals", "outputs"):
            for v in new[col].values():
                try:
                    v["stale"] = v.get("input_fingerprint") != fingerprint(
                        root, new, v["target_refs"]
                    )
                except (KeyError, OSError, ValueError, TypeError):
                    v["stale"] = True
        validate(new)
        atomic(root / "project.json", json.dumps(new, ensure_ascii=False, indent=2).encode())
        return {
            "revision": new["revision"],
            "restored_from": revision,
            "pre_restore_snapshot": "migration/revision-%s.json" % p["revision"],
            "notice": "project.json만 되돌림. 절 파일·원문·build/는 그대로이며 해시 불일치는 check에서 드러남",
        }


def _dependency_probe(root):
    """Real per-interpreter probe, not find_spec.

    gg_deps owns the contract that "installed somewhere else" is not usable: it
    imports each dependency inside the project's own .venv interpreter and
    checks the version range. gg.py doctor must not answer from the interpreter
    that happens to be running the CLI, which is what find_spec reported before.
    Mirrors what the app's doctor.all already does.
    """
    try:
        import gg_deps
    except ImportError:
        return None, {"probe": "unavailable"}
    try:
        report = gg_deps.doctor(root)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        return None, {"probe": "failed", "reason": str(e)}
    installed = {
        row["import_name"]: row["status"] == "installed"
        for row in report.get("dependencies", ())
    }
    return installed, report


def doctor(root):
    """Installation/lock/orphan detection. Detection is not execution proof."""
    import importlib.util

    root = Path(root)
    installed, deps_report = _dependency_probe(root)
    if installed is None:
        # Last resort only: says nothing about the project venv, so label it.
        installed = {
            m: bool(importlib.util.find_spec(m)) for m in ("docx", "openpyxl", "pypdf")
        }
        deps_report = dict(deps_report, notice="현재 CLI 인터프리터 기준 탐지. 프로젝트 .venv 검증 아님.")
    return {
        "python": sys.version,
        "dependencies": installed,
        "deps": deps_report,
        "recalculation": "not_run",
        "render": "not_run",
        "hwp": "unsupported",
        "web": "not_run",
        "model_calls": "disabled",
        "lock_present": (root / ".gg-lock").exists(),
        "lock": lock_info(root),
        "orphan_files": [
            str(p)
            for pattern in (".gg-tmp-*", ".gg-export-*", ".gg-import-*")
            for p in root.rglob(pattern)
        ],
        "notice": "설치 탐지는 실행 검증이 아님. 채팅만 가능하면 초안과 원답변 인계, 제출 후보 불가.",
    }
