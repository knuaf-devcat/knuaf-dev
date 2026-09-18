# knuaf-doc 동반 앱 (Electron + Python 사이드카)

에이전트(Codex / Claude Code)가 인터뷰·작문을 하는 동안, 학생이 **저장 상태·검사 결과·다음 할 일·산출물**을 보고
잠금 잔류·정본 손상 같은 막힘을 스스로 풀 수 있게 하는 데스크톱 GUI입니다. 앱 안에 AI는 없습니다.

## 구조

- `sidecar/knuaf_sidecar/` — stdlib만 쓰는 Python 프로세스. Electron이 `python -m knuaf_sidecar --scripts-dir <S>`로 띄우고
  JSON-lines(stdin/stdout)로 대화합니다. `gg_core`는 in-process로 호출하고(상태·검사·잠금·스냅샷·발행),
  CLI 전용 스크립트(build_docx, gg_excel_*, gg_office, gg_deps, gg_kordoc)는 서브프로세스로 실행해 출력을
  `{ok, exit, status, data, path, block_reason, stdout, stderr}` 봉투로 정규화합니다. 쓰기 메서드는 하나의 락으로 직렬화됩니다.
- `src/main/` — 인터프리터 선택(`KNUAF_PYTHON` > `<프로젝트>/.venv` > 번들 python > PATH), 사이드카 브리지, IPC, 설정.
- `src/preload/` — `window.knuaf` (contextIsolation, sandbox).
- `src/renderer/` — React 화면: 홈 / 대시보드(4레인) / 검사 결과 / 다음 할 일 / 절 목록(읽기 전용) / 산출물 / 문제 해결 / 설정.

## 개발

```bash
cd app
pnpm install
KNUAF_PYTHON=$(which python3.13) pnpm dev          # 개발 실행 (스크립트는 ../skills/knuaf-doc/scripts 를 사용)
pnpm typecheck
pnpm build && KNUAF_PYTHON=$(which python3.13) pnpm test:e2e   # Playwright-electron 스모크
```

사이드카 프로토콜 테스트는 저장소 루트의 `tests/test_sidecar.py`에 있습니다.

## 패키징 (Phase 6)

```bash
pnpm fetch:python       # python-build-standalone 3.12 → resources/python
pnpm build:wheelhouse   # openpyxl·python-docx·lxml·pypdf 휠 → resources/wheelhouse
pnpm dist:mac           # 또는 pnpm dist:win
```

번들 python은 `gg_deps.py ensure`의 base 인터프리터로만 쓰이고, 패키지는 계약대로 `<프로젝트>/.venv`에 설치됩니다.

## 지키는 규칙 (스킬 문서에서 옴)

- 인터뷰 답변을 GUI로 받지 않음(`interview-ui.md`). 절 본문은 읽기 전용.
- 학생에게 JSON·명령어·모델 선택을 요구하지 않음(`SKILL.md:15`).
- 기계검사 / 내용검토 / 출력검토 / 교수 승인 4레인을 하나로 합치지 않음(`SKILL.md:34`). 진행률 % 없음.
- 유효한 독립검토가 없으면 최상단에 `독립검토 미실행` 배너.
- 잠금은 같은 기기에서 종료된 프로세스의 것만 해제(`section-ledger.md`). 산출물은 절대 덮어쓰지 않음.
- 아무것도 기기 밖으로 보내지 않음.
