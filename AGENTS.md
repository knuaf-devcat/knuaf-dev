# 프로젝트 참고

검사 명령과 검토 범위는 `.harness.conf`에 있다. 프로젝트 고유 경계와 경로는 `CLAUDE.md`에 있다. 작업 시작 전에 이 디렉터리의 CLAUDE.md를 직접 읽고 프로젝트 경계와 금지를 적용한다.

런타임 차이: 이 저장소는 두 런타임을 함께 쓴다. JS는 `app/`에서 pnpm(electron-vite), 파이썬은 루트에서 `.venv-dev/bin/python`(3.13).
- 루트에는 package.json이 없다 → pnpm 명령은 `pnpm -C app …` 꼴로 실행한다.
- 파이썬 검사: `.venv-dev/bin/python -m pytest`, 린트 `.venv-dev/bin/python -m ruff check .`.
- 앱 e2e: `pnpm -C app build`를 먼저 돌린 뒤 `pnpm -C app exec playwright test`(스크린샷 스펙 제외, `live-*.spec.ts`는 `KNUAF_LIVE=1`일 때만 실제 로그인으로 돈다).
- Windows COM(pywin32) 경로는 코드와 정적 검사만 있고 실기기 검증이 없다 — 검증된 것으로 보고하지 않는다.
