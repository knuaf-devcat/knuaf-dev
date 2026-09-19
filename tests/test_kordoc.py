"""gg_kordoc: the bootstrap that downloads and runs a third-party npm CLI.

The risky part of this module is not parsing — it is that it fetches a package
and executes it on a student's machine. So these tests exercise the safety
contract with a **fake** Kordoc CLI injected through the `--kordoc` flag that
exists for exactly this purpose: no npm, no network, and they run on CI.

A real end-to-end parse needs Node + pnpm + the registry and is deliberately
left out; see `KNUAF_REAL_KORDOC` at the bottom.
"""
import json
import os
import stat
import sys

import pytest

import gg_kordoc as kd


# --- a stand-in for the real CLI ----------------------------------------------

PROBE = r'''import sys
argv = sys.argv[1:]
if argv[:1] == ["--version"]:
    print("kordoc 4.13.1")
    raise SystemExit(0)
if argv[:1] == ["--help"]:
    print("kordoc --format --silent --keep-empty-cols --keep-empty-paragraphs")
    raise SystemExit(0)
'''


def out_arg():
    return 'out = argv[argv.index("-o") + 1] if "-o" in argv else ""\n'


FAKE = PROBE + out_arg() + r'''
if out:
    open(out, "w", encoding="utf-8").write("# 변환됨\n\n본문 한 줄\n")
'''


def write_exe(path, body):
    """Write a fake CLI that this platform can actually execute.

    `body` is Python, not shell. Windows has neither `#!` nor an exec bit, so
    the same fake has to be reached through a `.cmd` launcher there — writing
    a `#!/bin/sh` script would make every test that asserts *refusal* pass for
    the wrong reason (the CLI never ran) and every other test fail.
    """
    impl = path.with_name(path.name + "-impl.py")
    impl.write_text(body, encoding="utf-8")
    if os.name == "nt":
        exe = path.with_name(path.name + ".cmd")
        exe.write_text('@"%s" "%s" %%*\r\n' % (sys.executable, impl), encoding="utf-8")
        return exe
    exe = path
    exe.write_text('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, impl), encoding="utf-8")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return exe


@pytest.fixture
def fake_cli(tmp_path):
    return write_exe(tmp_path / "kordoc", FAKE)


@pytest.fixture
def document(tmp_path):
    doc = tmp_path / "학교 지침.hwp"
    doc.write_bytes(b"\xd0\xcf\x11\xe0 fake hwp payload\n")
    return doc


# --- the input document is never touched --------------------------------------

def test_a_parsed_document_is_left_byte_identical(tmp_path, fake_cli, document):
    before = document.read_bytes()
    kd.parse(document, tmp_path / "out" / "지침.md", kordoc=str(fake_cli))
    assert document.read_bytes() == before, "원문이 바뀜"


def test_the_output_lands_where_it_was_asked_for(tmp_path, fake_cli, document):
    out = tmp_path / "out" / "지침.md"
    kd.parse(document, out, kordoc=str(fake_cli))
    assert out.is_file()
    assert "변환됨" in out.read_text(encoding="utf-8")


def test_no_staging_directory_is_left_behind(tmp_path, fake_cli, document):
    out = tmp_path / "out" / "지침.md"
    kd.parse(document, out, kordoc=str(fake_cli))
    assert not list(out.parent.glob(".gg-kordoc-*"))


# --- refusals that protect the student's files --------------------------------

def test_an_existing_output_is_never_overwritten(tmp_path, fake_cli, document):
    out = tmp_path / "지침.md"
    out.write_text("기존 내용", encoding="utf-8")
    with pytest.raises(kd.KordocBlocked) as caught:
        kd.parse(document, out, kordoc=str(fake_cli))
    assert caught.value.reason == "output_exists"
    assert "never overwritten" in caught.value.details["action"], "이른 가드가 아님"
    assert out.read_text(encoding="utf-8") == "기존 내용"


def test_an_output_that_appears_during_the_parse_is_still_not_overwritten(tmp_path, document):
    """The up-front check cannot see a file created while Kordoc runs, so there
    is a second check before publishing. This test reaches only that one."""
    racer = write_exe(tmp_path / "kordoc", PROBE + out_arg() + (
        'open(out, "w", encoding="utf-8").write("# 변환됨\\n")\n'
        'open(%r, "w", encoding="utf-8").write("끼어든 내용")\n' % str(tmp_path / "지침.md")))
    out = tmp_path / "지침.md"
    with pytest.raises(kd.KordocBlocked) as caught:
        kd.parse(document, out, kordoc=str(racer))
    assert caught.value.reason == "output_exists"
    assert "appeared during parse" in caught.value.details["action"], "늦은 가드에 도달하지 못함"
    assert out.read_text(encoding="utf-8") == "끼어든 내용", "끼어든 파일을 덮어씀"


def test_writing_over_the_input_is_refused(tmp_path, fake_cli, document):
    with pytest.raises(kd.KordocBlocked, match="input_output_same|never modified"):
        kd.parse(document, document, kordoc=str(fake_cli))


def test_a_missing_input_is_refused(tmp_path, fake_cli):
    with pytest.raises(kd.KordocBlocked, match="input_missing"):
        kd.parse(tmp_path / "없는파일.hwp", tmp_path / "out.md", kordoc=str(fake_cli))


def test_a_failing_cli_publishes_nothing(tmp_path, document):
    broken = write_exe(tmp_path / "kordoc", PROBE + "raise SystemExit(3)\n")
    out = tmp_path / "out" / "지침.md"
    with pytest.raises(kd.KordocBlocked, match="parse_failed|preserved"):
        kd.parse(document, out, kordoc=str(broken))
    assert not out.exists(), "실패했는데 출력이 남음"


def test_an_empty_result_is_not_published(tmp_path, document):
    silent = write_exe(tmp_path / "kordoc", PROBE + "raise SystemExit(0)\n")
    out = tmp_path / "out" / "지침.md"
    with pytest.raises(kd.KordocBlocked):
        kd.parse(document, out, kordoc=str(silent))
    assert not out.exists()


# --- an unusable CLI is rejected before anything runs -------------------------

@pytest.mark.skipif(os.name == "nt", reason="Windows에는 실행 비트가 없어 os.access(X_OK)가 항상 참")
def test_an_explicit_path_that_is_not_executable_is_refused(tmp_path, document):
    plain = tmp_path / "kordoc"
    plain.write_text("not executable", encoding="utf-8")
    with pytest.raises(kd.KordocBlocked, match="kordoc_missing"):
        kd.parse(document, tmp_path / "out.md", kordoc=str(plain))


def test_a_cli_that_is_not_kordoc_is_rejected(tmp_path, document):
    impostor = write_exe(tmp_path / "kordoc", 'print("pandoc 3.1.0")\n')
    with pytest.raises(kd.KordocBlocked):
        kd.parse(document, tmp_path / "out.md", kordoc=str(impostor))


def test_a_cli_missing_a_required_parse_flag_is_rejected(tmp_path, document):
    """Without --keep-empty-cols the tables come back with columns dropped."""
    partial = write_exe(tmp_path / "kordoc", r'''import sys
argv = sys.argv[1:]
if argv[:1] == ["--version"]:
    print("kordoc 4.13.1")
elif argv[:1] == ["--help"]:
    print("kordoc --format --silent")
''')
    with pytest.raises(kd.KordocBlocked):
        kd.parse(document, tmp_path / "out.md", kordoc=str(partial))


# --- credentials never reach the child process --------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("http://user:pass@proxy.example:3128", "http://proxy.example:3128"),
    ("user:pass@proxy.example:3128", "proxy.example:3128"),
    ("https://u:p@proxy.example/path@keep", "https://proxy.example/path@keep"),
    ("http://proxy.example:3128", "http://proxy.example:3128"),
    ("proxy.example", "proxy.example"),
])
def test_proxy_credentials_are_stripped(raw, expected):
    """A child that echoes its environment must not leak the student's password."""
    assert kd._strip_proxy_userinfo(raw) == expected


def test_the_child_environment_is_an_allowlist(monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "비밀")
    monkeypatch.setenv("HTTPS_PROXY", "https://user:pass@proxy.example:3128")
    env = kd._base_env()
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert env["HTTPS_PROXY"] == "https://proxy.example:3128"


def test_parsing_declares_the_offline_contract():
    env = kd._env_for_external(offline=True)
    assert env["KORDOC_OFFLINE"] == "1"
    assert kd._env_for_external(offline=False).get("KORDOC_OFFLINE") is None


# --- the cache is owned, not squatted -----------------------------------------

def test_an_empty_directory_is_claimed_with_a_marker(tmp_path):
    root = tmp_path / "cache"
    kd._claim_cache(root)
    marker = json.loads((root / ".gg-kordoc-cache.json").read_text(encoding="utf-8"))
    assert marker["owner"] == kd.OWNER
    assert marker["package"] == kd.PACKAGE
    assert marker["version"] == kd.VERSION
    assert marker["registry"] == kd.REGISTRY


def test_claiming_the_same_cache_twice_is_fine(tmp_path):
    root = tmp_path / "cache"
    kd._claim_cache(root)
    kd._claim_cache(root)


def test_a_populated_directory_is_never_taken_over(tmp_path):
    """Pointing --cache-dir at the wrong folder must not adopt its contents."""
    root = tmp_path / "내 문서"
    root.mkdir()
    (root / "논문.hwp").write_text("사용자 파일", encoding="utf-8")
    with pytest.raises(kd.KordocBlocked, match="cache_unowned"):
        kd._claim_cache(root)
    assert (root / "논문.hwp").read_text(encoding="utf-8") == "사용자 파일"


@pytest.mark.parametrize("marker", [
    {"owner": "someone.else", "package": "kordoc", "version": "4.13.1", "registry": "https://registry.npmjs.org"},
    {"owner": "knuaf-doc.gg_kordoc", "package": "other", "version": "4.13.1", "registry": "https://registry.npmjs.org"},
    {"owner": "knuaf-doc.gg_kordoc", "package": "kordoc", "version": "9.9.9", "registry": "https://registry.npmjs.org"},
    {"owner": "knuaf-doc.gg_kordoc", "package": "kordoc", "version": "4.13.1", "registry": "http://evil.example"},
])
def test_a_cache_claimed_by_something_else_is_refused(tmp_path, marker):
    root = tmp_path / "cache"
    root.mkdir()
    (root / ".gg-kordoc-cache.json").write_text(json.dumps(marker), encoding="utf-8")
    with pytest.raises(kd.KordocBlocked, match="cache_unowned"):
        kd._claim_cache(root)


def test_a_cache_from_the_previous_package_name_is_still_ours(tmp_path):
    """The skill was renamed; existing caches must not be abandoned."""
    root = tmp_path / "cache"
    root.mkdir()
    (root / ".gg-kordoc-cache.json").write_text(json.dumps(
        {"owner": "ginseng-goat.gg_kordoc", "package": kd.PACKAGE,
         "version": kd.VERSION, "registry": kd.REGISTRY}), encoding="utf-8")
    kd._claim_cache(root)


# --- the pinned version is a decision, not an accident ------------------------

def test_the_package_version_is_pinned_and_the_registry_is_the_public_one():
    assert kd.VERSION == "4.13.1", "버전을 올릴 때는 별도 검증이 필요하다"
    assert kd.REGISTRY == "https://registry.npmjs.org"


def test_every_subprocess_call_disables_the_shell():
    """shell=True with a student-supplied path would be a command injection."""
    src = (kd.__file__ and open(kd.__file__, encoding="utf-8").read()) or ""
    assert "shell=False" in src
    assert "shell=True" not in src
    assert src.count("subprocess.run(") == 1, "실행 경로가 하나여야 감사가 가능하다"


@pytest.mark.skipif(not os.environ.get("KNUAF_REAL_KORDOC"),
                    reason="real Kordoc + Node + pnpm + network; run by hand")
def test_a_real_kordoc_install_parses_a_document(tmp_path, document):
    out = tmp_path / "out" / "지침.md"
    kd.parse(document, out)
    assert out.is_file() and out.stat().st_size > 0
