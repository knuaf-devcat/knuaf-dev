import { defineConfig } from '@playwright/test'

/**
 * 설치본(dmg → /Applications) 전용 실행. 개발 빌드 e2e(`e2e/`, `playwright.config.ts`)와
 * **디렉터리·설정을 따로** 둔다:
 *
 * - 기존 `helpers.ts` 의 `launch()` 는 저장소 경로를 주입해 개발 빌드를 띄운다. 설치본 시험은
 *   그 주입을 지우고 번들 리소스만으로 도는지 본다(`e2e-installed/launch-installed.ts`).
 * - 기존 스펙 60여 개에 설치본 분기를 넣으면 모든 스펙이 두 배로 도는 대신, 설치본에서만
 *   깨질 수 있는 것(동봉 리소스·사이드카 python·첫 실행·userData·창)만 여기서 본다.
 *
 * 실행은 워크플로가 한다(`.github/workflows/installer-e2e.yml`). 손으로 돌릴 때:
 *   KNUAF_INSTALLED_APP="/Applications/<앱>.app" pnpm exec playwright test --config playwright.installed.config.ts
 */
export default defineConfig({
  testDir: 'e2e-installed',
  // 설치본 첫 실행은 온보딩·사이드카 기동까지 기다린다 — 개발 빌드보다 여유를 둔다.
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' }
})
