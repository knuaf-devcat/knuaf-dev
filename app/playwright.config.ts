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
  testIgnore: live ? [] : ['**/live-*.spec.ts']
})
