# knuaf-dev (한농대 창업논문 헬퍼)

학생이 창업논문을 쓰는 동안 에이전트가 인터뷰·작문을 하고, 앱이 저장 상태·검사·발행을 담당하는 데스크톱 GUI(Electron + React + Python 사이드카).

## 프로젝트 경계
- 작업 경로: `/Users/nara/knuaf-dev`
- 검사 명령과 검토 범위의 정본: `.harness.conf`
- 프로젝트 고유 금지:
  - 저작권이 불확실한 학교 공식 PDF·발췌본을 저장소에 넣지 않는다(README 명시 — 사용자가 자기 학교 원문을 직접 준비해 등록한다).
  - `app/out/`·`app/dist/`·`app/resources/`는 빌드 산출물이다. 소스처럼 손으로 고치지 않는다.

## do-not
- `.harness.conf`에 선언된 검사와 git 게이트를 건너뛰지 않는다(`--no-verify`·force-push·`git reset --hard`·`git clean` 포함).
- 사용자의 기존 변경·자산을 덮어쓰거나 삭제하지 않는다.
- 자격증명·키·토큰을 코드·스펙·로그·출력에 노출하지 않는다.
- 현재 HEAD에 묶인 독립 검토 증거 없이 보호 브랜치의 코드 변경을 push하지 않는다. 작성자와 최종 검토자를 같은 식별자로 기록하지 않는다.
- 승인 없는 프로덕션·계정·권한 변경을 하지 않는다.
- 종량제·잔액 차감·요청당 과금 경로를 실행하지 않는다. 자격증명·키·잔액의 존재는 승인이 아니며, 비종량제 경로임을 입증하지 못하면 실행 전에 실패로 닫는다. 미승인 자격증명 경로 변경이나 다른 실행 경로로 자동 대체하지 않는다.

## 프로젝트 지도
- `app/` — Electron 앱(electron-vite, React 19, Zustand). `src/main`(인터프리터 선택·사이드카 브리지·IPC·설정), `src/renderer`(내 논문·자료·결과물·점검·설정), `sidecar/knuaf_sidecar`(stdlib 파이썬, JSON-lines).
- `skills/knuaf-dev/` — 에이전트 스킬. `scripts/`(gg_core·CLI 스크립트), `references/`, `SKILL.md`.
- `tests/` — 루트 pytest(스킬·사이드카·문서 로직). `app/e2e/`·`app/*.spec.ts` — Playwright(electron, `out/` 빌드 산출물 대상).
- `docs/` — 학생용 안내(md/html/pdf)·설치 안내. `pyproject.toml` — pytest·ruff 설정.
