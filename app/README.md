# KNUAF-Dev · 창업논문 작성 도우미 (Electron + Python 사이드카)

에이전트(Codex / Claude Code)가 인터뷰·작문을 하는 동안, 학생이 **저장 상태·검사 결과·다음 할 일·산출물**을 보고
잠금 잔류·정본 손상 같은 막힘을 스스로 풀 수 있게 하는 데스크톱 GUI입니다. AI 도우미를 연결하면 답변과 작업 폴더의
내용이 선택한 제공업체(OpenAI 또는 Anthropic)로 전송됩니다. 앱 자체는 그 외 어디에도 자료를 보내지 않습니다.

## 구조

- `sidecar/knuaf_sidecar/` — stdlib만 쓰는 Python 프로세스. Electron이 `python -m knuaf_sidecar --scripts-dir <S>`로 띄우고
  JSON-lines(stdin/stdout)로 대화합니다. `gg_core`는 in-process로 호출하고(상태·검사·잠금·스냅샷·발행),
  CLI 전용 스크립트(build_docx, gg_excel_*, gg_office, gg_deps, gg_kordoc)는 서브프로세스로 실행해 출력을
  `{ok, exit, status, data, path, block_reason, stdout, stderr}` 봉투로 정규화합니다. 쓰기 메서드는 하나의 락으로 직렬화되며,
  `methods.list`가 각 메서드의 쓰기 여부를 보고합니다. 읽기 전용 조회로 `materials.list`(intake 사실 + sources/ 파일),
  `artifact.list`(build/ 산출물 스캔), `artifact.preview`(xlsx 읽기 전용 표·md 텍스트·pdf 표지)가 있습니다.
- `src/main/` — 인터프리터 선택(`KNUAF_PYTHON` > `<프로젝트>/.venv` > 번들 python > PATH), 사이드카 브리지, IPC, 설정.
  `file:read`는 작업 폴더 안 `.pdf`/`.md`/`.txt`만(50MB 이하) 바이트로 돌려주고, `file:save-as`는 폴더 안 파일을
  사용자가 고른 위치로 복사합니다 — 둘 다 경로가 폴더 밖으로 나가면 거절합니다.
- `src/main/chat/` — Codex App Server(`codex app-server`)·Claude Agent SDK와의 구조화 채팅. 스냅샷은
  `<프로젝트>/.knuaf-gui/chat-<provider>.json`에 남고, 실행 중 종료는 `interrupted`/`uncertain`으로 복구됩니다.
  도우미 실행 중에는 사이드카 쓰기 호출이 `agent_busy`로 거절됩니다(반대로 앱이 쓰기 중이면 채팅 전송이 거절됩니다).
  `~/.codex/skills`·`~/.agents/skills`에 남은 전역 `knuaf-dev` 사본은 codex `-c skills.config=…` 오버라이드로
  그 세션에서만 끕니다(사용자 config.toml은 건드리지 않음) — 낡은 사본이 프로젝트 사본과 이름 충돌하지 않게.
- `src/main/userdata.ts` — 앱 표시이름이 바뀌며 생긴 옛 `userData` 폴더에서 `settings.json`을 한 번 이어 받습니다.
  새 폴더가 이미 설정을 갖고 있으면 건드리지 않고 옛 폴더도 삭제하지 않습니다. 이름을 또 바꾸면
  `LEGACY_USERDATA_NAMES`에 옛 폴더 이름을 추가하세요.
- `src/preload/` — `window.knuaf` (contextIsolation, sandbox).
- `src/renderer/` — React 화면. 메뉴 5개: **내 논문**(도우미 채팅 — `helper_mode`로 기억) /
  **자료** / **결과물**(목록·미리보기·파일 만들기) / **점검**(할 일·고칠 곳·네 가지 확인) /
  **설정**(폴더·도우미 연결·문제 해결·고급 도구·실행기). 사이드바 하단은 논문 차례(읽기 전용).
  `helper_mode`는 `codex-chat`/`claude-chat` 둘(claude-chat은 Agent SDK 경로로 아직 실험 중);
  구 `codex_terminal`과 제거된 인앱 터미널 값(`codex-term`/`claude-term`)은 로드 때 채팅으로
  마이그레이션됩니다(`src/main/settings.ts`). 채팅이 막힐 때의 비상구는 설정의
  "앱 밖 터미널로 도우미 열기" 버튼(`.command` + `shell.openPath`)입니다.
  - 자료: intake 사실로 기록된 현재 작성물·재무 파일과 sources/ 파일 목록(현재 작성물·참고자료 구분)을 보여 줍니다.
    파일을 골라도 채팅 답변에 경로를 넣을 뿐 현재 작성물로 채택하지 않습니다(intake-selection.md).
  - 결과물: build/ 아래 DOCX·XLSX·PDF·MD를 목록·미리보기·다른 이름 저장·외부 열기 합니다. PDF는 pdf.js
    (`pdfjs-dist`, Electron 37 Chromium과 맞지 않아 `legacy` 빌드)로 그리고, DOCX는 같은 이름의 PDF(같은 폴더 또는
    build/native)가 있을 때만 그 PDF를 보여 주며, 없으면 Office 렌더 버튼과 "원래 앱으로 열기"를 둡니다.
    XLSX는 사이드카가 openpyxl로 읽은 표를 그립니다(재계산 안 된 수식이 과반이면 경고).

스킬(`knuaf-dev`)은 전역이 아니라 프로젝트 로컬(`<프로젝트>/.claude/skills`, `<프로젝트>/.agents/skills`)에 설치됩니다.

## 개발

```bash
cd app
pnpm install
KNUAF_PYTHON=$(which python3.13) pnpm dev          # 개발 실행 (스크립트는 ../skills/knuaf-dev/scripts 를 사용)
pnpm typecheck
pnpm build && KNUAF_PYTHON=$(which python3.13) pnpm test:e2e   # Playwright-electron 스모크
```

사이드카 프로토콜 테스트는 저장소 루트의 `tests/test_sidecar.py`에 있습니다.

개발·테스트 전용 환경 변수:

- `KNUAF_CLAUDE_MODEL=sonnet` — Claude 채팅 SDK 세션에 `model`을 고정합니다(테스트 전용).
- `KNUAF_DRY_LAUNCH=1` — 외부 터미널 실행 스크립트를 쓰기만 하고 열지 않습니다(테스트 전용).
- `KNUAF_LIVE=1` — `e2e/live-*.spec.ts`를 포함해 실행합니다. 실제 Claude/Codex 로그인과 구독 사용량이 필요하므로 기본 실행에서는 제외됩니다.

## 패키징 (Phase 6)

```bash
pnpm dist:mac           # 또는 pnpm dist:win
```

`dist:*`는 필요한 리소스(번들 python, 휠하우스, 아이콘, 학생용 안내 PDF, 스테이징된 스킬)를
먼저 준비합니다. 개별로 돌리려면:

```bash
pnpm fetch:python       # python-build-standalone 3.12 → resources/python
pnpm build:wheelhouse   # openpyxl·python-docx·lxml·pypdf 휠 → resources/wheelhouse
pnpm build:icons        # build/icon.svg → icns·ico·png
pnpm build:guide        # docs/학생용-사용안내.md → .html·.pdf
pnpm stage:skill        # ../skills/knuaf-dev → resources/skill
```

번들 python은 `gg_deps.py ensure`의 base 인터프리터로만 쓰이고, 패키지는 계약대로 `<프로젝트>/.venv`에 설치됩니다.

## 지키는 규칙 (스킬 문서에서 옴)

- 인터뷰 답변을 GUI로 받지 않음(`interview-ui.md`). 절 본문은 읽기 전용.
- 학생에게 JSON·명령어·모델 선택을 요구하지 않음(`SKILL.md:15`).
- 기계검사 / 내용검토 / 출력검토 / 교수 승인 4레인을 하나로 합치지 않음(`SKILL.md:34`). 진행률 % 없음.
- 유효한 독립검토가 없으면 최상단에 `독립검토 미실행` 배너.
- 잠금은 같은 기기에서 종료된 프로세스의 것만 해제(`section-ledger.md`). 산출물은 절대 덮어쓰지 않음.
- AI 도우미를 연결하면 답변과 작업 폴더의 내용이 선택한 제공업체(OpenAI 또는 Anthropic)로 전송됨.
  앱 자체는 그 외 어디에도 자료를 보내지 않음.
