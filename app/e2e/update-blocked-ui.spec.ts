import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { launch, navTo } from './helpers'

test('Windows owner block replaces install even in an open or in-flight dialog', async ({}, testInfo) => {
  const { electronApp, page: originalPage } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', KNUAF_UPDATE_PUBLIC_KEY: '', KNUAF_UPDATE_CHANNEL_URL: '' } })
  const preload = readFileSync(resolve(__dirname, '..', 'out', 'preload', 'index.js'), 'utf8')
  const windowsPreload = preload.replace('platform: process.platform,', "platform: 'win32',")
  expect(windowsPreload).not.toBe(preload)
  const winPreload = windowsPreload.replace('install: () => electron.ipcRenderer.invoke("app-update:install"),',
    'install: () => electron.ipcRenderer.invoke("app-update:install").then(reply => { document.documentElement.dataset.installReplied = "yes"; return reply }),')
  expect(winPreload).not.toBe(windowsPreload)
  const path = testInfo.outputPath('windows-preload.cjs')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, winPreload)
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { installs?: number; pages?: number; pageArgs?: unknown[]; guides?: number; appChecks?: number; finishInstall?: () => void }
      g.installs = 0; g.pages = 0; g.guides = 0; g.appChecks = 0
      for (const channel of ['app-update:status', 'app-update:check', 'app-update:install', 'app-update:open-page', 'guide:open']) ipcMain.removeHandler(channel)
      ipcMain.handle('app-update:status', () => ({ result: { phase: 'unavailable', current: '0.5.1', latest: null, page: null } }))
      ipcMain.handle('app-update:check', () => { g.appChecks!++; return { result: { phase: 'unavailable', current: '0.5.1', latest: null, page: null } } })
      ipcMain.handle('app-update:open-page', (_event, ...args: unknown[]) => { g.pages!++; g.pageArgs = args; return { result: true } })
      ipcMain.handle('guide:open', () => { g.guides!++; return true })
      ipcMain.handle('app-update:install', async event => {
        g.installs!++
        event.sender.send('app-update:status', { phase: 'blocked', reason: 'store_owner', current: '0.5.1', latest: '0.6.0', page: 'https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v0.6.0' })
        await new Promise<void>(resolve => { g.finishInstall = resolve })
        return { error: { code: 'update', message: 'owner blocked' } }
      })
    })
    const event = electronApp.waitForEvent('window')
    const windowId = await electronApp.evaluate(async ({ BrowserWindow }, options) => {
      const win = new BrowserWindow({ show: false, webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true } })
      await win.loadURL(options.url)
      return win.webContents.id
    }, { preload: path, url: originalPage.url() })
    const page = await event
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.waitForSelector('.titlebar')
    expect(await page.evaluate(() => window.knuaf.platform)).toBe('win32')
    await navTo(page, '설정')
    await expect(page.getByRole('region', { name: '업데이트' }).locator('p.caption', { hasText: '앱 판' })).toContainText('확인할 수 없어요')
    await page.locator('dialog[data-screen="settings"] > .sheet-head button[aria-label="닫기"]').click()
    const send = (latest: string | null, phase = 'blocked') => electronApp.evaluate(({ webContents }, payload) => {
      webContents.fromId(payload.id)!.send('app-update:status', { phase: payload.phase, reason: payload.phase === 'blocked' ? 'store_owner' : undefined,
        current: '0.5.1', latest: payload.latest, page: payload.latest ? 'https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v0.6.0' : 'https://github.com/knuaf-devcat/knuaf-dev/releases' })
    }, { id: windowId, latest, phase })
    await send('0.6.0', 'available')
    await page.locator('.titlebar').getByRole('button', { name: '업데이트', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '새 앱 0.6.0이 나왔어요' })
    await expect(dialog.getByRole('button', { name: '지금 설치' })).toBeEnabled()
    await send('0.6.0')
    await expect(dialog).toContainText('다음 업데이트도 같은 방법으로 설치해야 해요')
    await expect(dialog.getByRole('button', { name: '지금 설치' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '다시 시도' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '내려받기 페이지 열기' }).click()
    await expect.poll(() => electronApp.evaluate(() => (globalThis as typeof globalThis & { pages?: number }).pages)).toBe(1)
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { pageArgs?: unknown[] }).pageArgs)).toEqual([])
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { installs?: number }).installs)).toBe(0)
    await send(null)
    dialog = page.getByRole('dialog', { name: '앱 업데이트 안내' })
    await expect(dialog).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await expect.poll(() => dialog.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
      await page.screenshot({ path: resolve(__dirname, '..', '..', '..', 'w3-work', `blocked-${colorScheme}.png`) })
    }
    await dialog.getByRole('button', { name: '설치 안내 보기' }).click()
    await dialog.getByRole('button', { name: '나중에' }).click()
    await navTo(page, '설정')
    const section = page.getByRole('region', { name: '업데이트' })
    await expect(section).toContainText('자동 업데이트를 사용할 수 없어요')
    await expect(section).toContainText('다음 업데이트도 같은 방법으로 설치해야 해요')
    await section.getByRole('button', { name: '지금 확인' }).click()
    await expect(section.getByRole('button', { name: '지금 확인' })).toBeEnabled()
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { appChecks?: number }).appChecks)).toBe(0)
    await expect(section).toContainText('자동 업데이트를 사용할 수 없어요')
    await section.getByRole('button', { name: '내려받기 페이지 열기' }).click()
    await expect.poll(() => electronApp.evaluate(() => (globalThis as typeof globalThis & { pages?: number }).pages)).toBe(2)
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { guides?: number }).guides)).toBe(1)
    await page.locator('dialog[data-screen="settings"] > .sheet-head button[aria-label="닫기"]').click()
    await send('0.6.0', 'available')
    await page.locator('.titlebar').getByRole('button', { name: '업데이트', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '새 앱 0.6.0이 나왔어요' })
    await dialog.getByRole('button', { name: '지금 설치' }).click()
    await expect(dialog).toContainText('다음 업데이트도 같은 방법으로 설치해야 해요')
    await expect(dialog.getByRole('button', { name: '지금 설치' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '다시 시도' })).toHaveCount(0)
    await electronApp.evaluate(() => { (globalThis as typeof globalThis & { finishInstall?: () => void }).finishInstall!() })
    await page.waitForFunction(() => document.documentElement.dataset.installReplied === 'yes')
    await expect(dialog.getByRole('button', { name: '내려받기 페이지 열기' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '다시 시도' })).toHaveCount(0)
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { installs?: number }).installs)).toBe(1)
  } finally { await electronApp.close() }
})
