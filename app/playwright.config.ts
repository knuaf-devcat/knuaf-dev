import { defineConfig } from '@playwright/test'

/**
 * `live-*.spec.ts` drive a real, logged-in Claude/Codex CLI and spend real
 * subscription usage, so they are opt-in: `KNUAF_LIVE=1 pnpm test:e2e`.
 * Without the flag they are ignored entirely — CI must be able to run
 * `pnpm test:e2e` without a login, a network, or a 45-minute budget.
 */
const live = process.env.KNUAF_LIVE === '1'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  // 가끔만 깨지는 실패는 다음 통과 실행이 test-results 를 지워 버려서 원인을 못 본다.
  // retries 를 올리면 실패가 초록에 묻히므로 올리지 않고, 대신 흔적만 남긴다.
  // (materials.spec 이 전체 실행에서 8번 중 2번 깨졌는데 기록이 남지 않아 못 팠다.)
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  testIgnore: live ? [] : ['**/live-*.spec.ts']
})
