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
  사이드카의 폴더 설정·재시작은 직렬화하고, 이전 프로세스와 stdio의 종료를 확인하기 전에는 새 실행기를 띄우지 않습니다.
  시작 응답(`ready`와 `methods.list` 합계)은 10초 제한이며, 실패하면 소유 프로세스를 종료·정리합니다.
  종료 요청은 진행 중인 시작과 이미 큐에 있던 시작을 취소하고 즉시 종료 절차에 들어갑니다. 동시 종료 요청은 같은 정리에 합류합니다.
  정상 종료 3초 뒤 강제종료를 시도하며 종료 절차 전체 6초 안에 확인되지 않으면 실패로 격리합니다. Windows 강제종료는
  `taskkill /PID <소유 PID> /T /F` 성공과 sidecar close를 모두 요구합니다(launcher/base 전파는 Windows 실기기 확인 필요).
  종료 오류의 `data.recovery=retry_stop`이면 설정의 **적용·재시작**으로 같은 실행기 종료를 재시도합니다.
  `external_cleanup`이면 새 spawn 없이 외부 정리 안내를 표시합니다. 앱만 다시 켜도 잔류 프로세스가 없어짐을 보장하지 않으며,
  다른 작업을 저장한 뒤 컴퓨터 재시작을 안내합니다. 앱 종료도 사이드카 종료 결과를 기다립니다.
- `src/main/chat/` — Codex App Server(`codex app-server`)·Claude Agent SDK와의 구조화 채팅. 스냅샷은
  `<프로젝트>/.knuaf-gui/chat-<provider>.json`에 남고, 실행 중 종료는 `interrupted`/`uncertain`으로 복구됩니다.
  앱 종료가 시작되면 연결 상태를 다시 조회하거나 새 도우미 연결을 만들지 않고 기존 연결을 정리합니다.
  도우미 실행 중에는 사이드카 쓰기 호출이 `agent_busy`로 거절됩니다(반대로 앱이 쓰기 중이면 채팅 전송이 거절됩니다).
  `~/.codex/skills`·`~/.agents/skills`에 남은 전역 `knuaf-dev` 사본은 codex `-c skills.config=…` 오버라이드로
  그 세션에서만 끕니다(사용자 config.toml은 건드리지 않음) — 낡은 사본이 프로젝트 사본과 이름 충돌하지 않게.
- `src/main/userdata.ts` — 앱 표시이름이 바뀌며 생긴 옛 `userData` 폴더에서 `settings.json`을 한 번 이어 받습니다.
  새 폴더가 이미 설정을 갖고 있으면 건드리지 않고 옛 폴더도 삭제하지 않습니다. 이름을 또 바꾸면
  `LEGACY_USERDATA_NAMES`에 옛 폴더 이름을 추가하세요.
- `src/preload/` — `window.knuaf` (contextIsolation, sandbox).
- `src/renderer/` — React 화면. 앱을 켜면 대화 입력칸이 바로 열리고, 모델 칩에서 AI 연결과 전환을 관리합니다.
  왼쪽 프로젝트 목록은 최근 폴더를 보여 주며 좁은 창에서는 서랍으로 열립니다. 첫 메시지 뒤
  `문서/knuaf-dev/<논문 이름>`에 새 폴더를 만들거나 기존 폴더를 고릅니다. 같은 이름이 있으면 새 이름을 붙여 기존 폴더를 보존합니다.
  폴더 생성 중 새 논문을 시작하면 이전 요청은 대화를 열거나 보내지 않습니다. 이미 만들어진 폴더는 자동 삭제하지 않습니다.
  프로젝트 목록에서 파일 관리자로 폴더를 열 수 있습니다. AI 회사는 서로 대화 맥락을 공유하지 않습니다.
  **자료** / **결과물**(목록·미리보기·파일 만들기) / **점검**(할 일·고칠 곳·네 가지 확인) /
  **설정**(폴더·도우미 연결·문제 해결·고급 도구·실행기)은 작업 공간 위에 엽니다.
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

### 모델 칩

입력칸의 모델 칩에서 계정이 쓸 수 있는 ChatGPT 모델과 생각 깊이를 고릅니다.
폴더를 정하기 전에도 고를 수 있으며, 선택은 `settings.json.chat_models`에 공급자별로 남습니다.
같은 회사 모델은 다음 메시지부터 같은 대화에 적용됩니다. 기본은 **안 고름(계정 기본)**입니다.
고른 적 없는 학생에게는 기본값 확인용 임시 대화를 만들지 않고, 전송에 model·effort도 붙이지 않습니다(L-02).

추천과 용도는 `src/shared/chat.ts`의 확정표를 씁니다. 계정 목록에 Sol 또는 Astra가 있으면 높음 줄,
없으면 낮음 줄을 쓰고, 목록에 없는 모델·숨긴 모델은 표시하지 않습니다.
별칭과 실제 계정 모델의 대응·요금제별 이용 가능 여부는 실기기 확인 대상입니다.
Claude는 모델 목록·추천 없이 기존 계정 기본값을 유지합니다.
검토는 새 대화 안내만 제공하며, 검토용 새 대화나 자동 모델 전환은 구현하지 않습니다.

대화 로드 때 목록을 자동 조회하지 않습니다. 칩을 열면 조회하고, 오류 시 **모델 목록 새로고침**으로 재조회합니다.
읽기 중 새 선택이 시작됐거나 읽기 시작 시 선택 저장이 진행 중이었다면 그 응답의 옛 선택은
화면에 반영하지 않습니다(MC1-03). 관련 회귀는 `e2e/model-chip.spec.ts`,
실제 Electron 조작·같은 대화 전송·밝음/어두움·1440/1024 배치는 `e2e/model-picker-ui.spec.ts`에서 확인합니다.
캡처가 필요하면 `KNUAF_CHIP_CAPTURE_DIR=<저장 폴더>`를 지정해 후자를 실행합니다.
직접 가짜 Codex 연결을 만드는 시험도 `skillTargets()`·`installSkill()`로 프로젝트 스킬을 실제 설치하고,
`subscriptionEnv()`·`fakeCodexEnv()`·`findExecutable()`로 구독 환경과 실행 파일 탐색을 공유합니다.
Windows의 `codex.cmd`·`Path/PATH`와 설치 파일의 경로 별칭을 시험에서 따로 추측하지 않습니다.
가짜 서버의 `skills/list`도 존재하는 `SKILL.md`만 realpath로 보고합니다. 스킬 누락 시 전송 차단과
한글·공백 폴더를 가리키는 별칭(Windows junction/Unix 심링크)의 전송 회귀를 `model-chip.spec.ts`에 둡니다.

### 첫 메시지와 질문 카드

폴더 카드에서 넘긴 첫 메시지는 전송 전에 원래 논문의 초안에 기존 글과 함께 보관합니다.
모델 기본값 확인이나 폴더 준비가 실패·취소되면 그대로 남고, 다른 논문을 보고 있어도 그 논문 초안에 복원됩니다.
전송이 받아들여지면 보관본이 그대로일 때만 기존 초안으로 되돌립니다. 이를 위해
`chat.setDraft(root, text, expected?)`는 `expected`가 있으면 메인의 최신 초안이 일치할 때만 쓰고 성공 여부를 반환합니다.
대화 파일 형식과 폴더×AI 연결 열쇠는 바꾸지 않습니다.

질문 카드 아래에도 같은 모델 칩이 있으며, 모델·생각 깊이를 바꿔도 질문과 직접 입력 초안은 남습니다.
긴 첫 메시지는 표시 높이를 제한하고 내부 스크롤로 읽습니다. 첫 화면 자체도 스크롤할 수 있어 폴더 조작이 막히지 않습니다.
INT1 회귀는 `e2e/int1.spec.ts`가 실제 prepare 실패·늦은 성공·새 편집 보존·질문 답변·1024×768 포인터 접근을 확인합니다.
`KNUAF_INT1_CAPTURE_DIR=<저장 폴더>`를 지정하면 질문 카드와 긴 첫 메시지의 밝음·어두움 캡처를 그곳에 저장합니다.

전송 승인이나 첫 메시지의 초안 정리 응답이 늦어도, 그 사이 스트림으로 받은 답변·완료 스냅샷을
옛 승인 스냅샷으로 덮지 않습니다. `e2e/int1-ci.spec.ts`는 두 반환 지점을 각각 붙잡아 이 순서를 검증합니다.
종료 중에는 앞서 시작한 `project.open()`이 늦게 `chat.load()`를 호출할 수 있습니다.
`e2e/agent-busy.spec.ts`는 그 추가 조회도 발생시키며, 호출 횟수가 아니라 모든 늦은 조회의 종료 오류와
실제 Codex 시작 기록이 늘지 않는 것을 종료 전후에 확인합니다.

## 개발

```bash
cd app
pnpm install
KNUAF_PYTHON=$(which python3.13) pnpm dev          # 개발 실행 (스크립트는 ../skills/knuaf-dev/scripts 를 사용)
pnpm typecheck
pnpm build && KNUAF_PYTHON=$(which python3.13) pnpm test:e2e   # Playwright-electron 스모크
```

사이드카 프로토콜 테스트는 저장소 루트의 `tests/test_sidecar.py`에 있습니다.

알려진 A안 한계(독립검토 A1): 사용자 문구의 `copy.ts` 중앙관리 AST 검사는 대체 없이 제거되어
일부 새 화면 문구가 인라인입니다(A1-04). 첫 화면에는 시안의 세 가지 시작 제안 칩이 없습니다(A1-05).

브리지 수명주기·격리 회귀는 `e2e/sidecar-lifecycle.spec.ts`, 실제 Electron 재시작·오류 표시·PID 정리는
`e2e/sidecar-app.spec.ts`에서 확인합니다: `pnpm -C app build && pnpm -C app exec playwright test sidecar-lifecycle.spec.ts sidecar-app.spec.ts`.

개발·테스트 전용 환경 변수:

- `KNUAF_CLAUDE_MODEL=sonnet` — Claude 채팅 SDK 세션에 `model`을 고정합니다(테스트 전용).
- `KNUAF_DRY_LAUNCH=1` — 외부 터미널 실행 스크립트를 쓰기만 하고 열지 않습니다(테스트 전용).
- `KNUAF_LIVE=1` — `e2e/live-*.spec.ts`를 포함해 실행합니다. 실제 Claude/Codex 로그인과 구독 사용량이 필요하므로 기본 실행에서는 제외됩니다.
- `KNUAF_WINDOW_SHOTS=1` — 실제 창을 맨 앞으로 올려 찍는 macOS 안내서 사진 생성기 `e2e/window-shots.spec.ts`를 함께 돌립니다: `KNUAF_WINDOW_SHOTS=1 pnpm -C app test:e2e`. e2e 창은 기본적으로 화면에 뜨지 않습니다(`KNUAF_E2E_HIDDEN=1` — 창을 눈으로 보려면 `KNUAF_E2E_VISIBLE=1`).
- 화면 확인용: `app/e2e/watch-frontmost.sh <기록 파일> [초]`(macOS) — 0.5초 간격으로 화면 맨 앞 앱과 창이 화면에 있는 앱을 기록합니다.

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
