import { expect, test } from '@playwright/test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, navTo, openProject, synthProject } from './helpers'
import { fakeCodexEnv, replyFile, scratch, userDataWith } from './fixtures/fake-codex'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
function zip(entries: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [path, bytes] of Object.entries(entries)) {
    const name = Buffer.from(path), a = Buffer.alloc(30), b = Buffer.alloc(46)
    a.writeUInt32LE(0x04034b50); a.writeUInt16LE(20, 4); a.writeUInt16LE(0x800, 6)
    a.writeUInt32LE(bytes.length, 18); a.writeUInt32LE(bytes.length, 22); a.writeUInt16LE(name.length, 26)
    b.writeUInt32LE(0x02014b50); b.writeUInt16LE(0x314, 4); b.writeUInt16LE(20, 6); b.writeUInt16LE(0x800, 8)
    b.writeUInt32LE(bytes.length, 20); b.writeUInt32LE(bytes.length, 24); b.writeUInt16LE(name.length, 28)
    b.writeUInt32LE((0x81a4 << 16) >>> 0, 38); b.writeUInt32LE(offset, 42)
    local.push(a, name, bytes); central.push(b, name); offset += a.length + name.length + bytes.length
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dir, end])
}

test('signed local channel: install, rollback, incompatible app and offline', async () => {
  test.skip(process.platform !== 'darwin', 'macOS page action; Windows installer is not run in this test')
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const files: Record<string, Buffer> = {}
  const collect = (dir: string, prefix = ''): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) collect(join(dir, entry.name), name)
      else if (entry.isFile()) files[name] = readFileSync(join(dir, entry.name))
    }
  }
  collect(resolve(__dirname, '..', '..', 'skills', 'knuaf-dev'))
  files['SKILL.md'] = Buffer.concat([files['SKILL.md'], Buffer.from('\n<!-- W3 test update -->\n')])
  files['skill.json'] = Buffer.from('{"version":"1.0.1","api":1}')
  const archive = zip(files), url = 'https://github.com/knuaf-devcat/knuaf-dev/releases/download/skill-v1.0.1/skill.zip'
  let needsApp = false, offline = false, appLatest = '0.5.1'
  const server = createServer((_req, res) => {
    if (offline) { res.writeHead(503).end(); return }
    const m = { schema: 1, name: 'knuaf-dev', version: '1.0.1', api: needsApp ? 2 : 1, minApp: '0.5.1', url, size: archive.length, sha256: sha(archive), files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha(bytes)])) }
    const bytes = Buffer.from(JSON.stringify(m))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ schema: 1, skill: { manifest: bytes.toString('base64'), sig: sign(null, bytes, pair.privateKey).toString('base64') }, app: { latest: appLatest, page: `https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v${appLatest}` } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server address')
  const dir = scratch(), root = synthProject()
  const userData = userDataWith(dir, { helper_mode: 'codex-chat', provider_choice: { provider: 'codex', at: '' } })
  const env = fakeCodexEnv(join(dir, 'bin'), { FAKE_CODEX_MODE: 'logged-in', FAKE_CODEX_REPLY: replyFile(dir, '시험 응답입니다') })
  const { electronApp, page } = await launch({ userData, env: { ...env, KNUAF_UPDATE_PUBLIC_KEY: publicKey, KNUAF_UPDATE_CHANNEL_URL: `http://127.0.0.1:${addr.port}/channel` } })
  try {
    await electronApp.evaluate(({ session }, data) => {
      session.defaultSession.protocol.handle('https', req => req.url === data.url
        ? new Response(Buffer.from(data.archive, 'base64')) : new Response('blocked', { status: 403 }))
    }, { url, archive: archive.toString('base64') })
    await openProject(page, root)
    await expect(page.getByTitle('이 논문의 도우미')).toContainText('연결됨', { timeout: 30000 })
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('업데이트 전 대화')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('시험 응답입니다')).toBeVisible({ timeout: 30000 })
    await navTo(page, '설정')
    const section = page.getByRole('region', { name: '업데이트' })
    await expect(section).toContainText('새 규칙집 1.0.1이 있어요')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await section.scrollIntoViewIfNeeded()
      await page.screenshot({ path: resolve(__dirname, '..', '..', '..', 'w3-work', `update-${colorScheme}.png`) })
    }
    await section.getByRole('button', { name: '업데이트', exact: true }).click()
    await expect(section).toContainText('현재 규칙집 1.0.1', { timeout: 30000 })
    await page.locator('dialog[data-screen="settings"] > .sheet-head button[aria-label="닫기"]').click()
    await page.getByRole('textbox', { name: '답변을 입력하세요' }).fill('업데이트 후 대화')
    await page.getByRole('button', { name: '보내기', exact: true }).click()
    await expect(page.getByText('규칙집이 갱신됐어요', { exact: false })).toBeVisible({ timeout: 30000 })
    await navTo(page, '설정')
    await section.getByRole('button', { name: '이전 규칙집으로' }).click()
    await expect(section).toContainText('현재 규칙집 1.0.0')
    needsApp = true
    await section.getByRole('button', { name: '지금 확인' }).click()
    await expect(section).toContainText('이 규칙집은 앱 새 판이 필요해요')
    await expect(section).toContainText('지금 규칙집은 그대로 쓸 수 있어요')
    await expect(section.getByRole('button', { name: '앱 업데이트' })).toHaveCount(0)
    offline = true
    await section.getByRole('button', { name: '지금 확인' }).click()
    await expect(section).toContainText('다시 시도')
    offline = false; appLatest = '99.0.0'
    await section.getByRole('button', { name: '지금 확인' }).click()
    await expect(section.getByRole('button', { name: '내려받기 페이지 열기' })).toBeVisible()
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => { (globalThis as typeof globalThis & { openedUpdate?: string }).openedUpdate = url }
    })
    await section.getByRole('button', { name: '내려받기 페이지 열기' }).click()
    await expect.poll(() => electronApp.evaluate(() => (globalThis as typeof globalThis & { openedUpdate?: string }).openedUpdate)).toBe('https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v99.0.0')
    await page.locator('dialog[data-screen="settings"] > .sheet-head button[aria-label="닫기"]').click()
    await page.locator('.titlebar').getByRole('button', { name: '업데이트', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '새 앱 99.0.0이 나왔어요' })).toBeVisible()
    await page.getByRole('button', { name: '나중에' }).click()
  } finally {
    await electronApp.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('connection probe returns pause immediately and preserves later success and real errors', async () => {
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin' } })
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { probeMode?: string; attempts?: number }
      g.probeMode = 'paused'; g.attempts = 0
      for (const channel of ['connect:status', 'chat:status']) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => {
          g.attempts = (g.attempts ?? 0) + 1
          if (g.probeMode === 'paused') return { error: { code: 'update_suspended', message: '업데이트를 준비하고 있어요' } }
          if (g.probeMode === 'error') return { error: { code: 'chat', message: '실제 로그인 실패' } }
          return { result: { installed: true, connected: true, version: null, detail: '' } }
        })
      }
    })
    const probe = () => page.evaluate(() => Promise.all([window.knuaf.connect.status('codex'), window.knuaf.chat.status('/test', 'codex')]))
    const paused = await probe() as { error: { code: string; message: string } }[]
    expect(paused.map(r => r.error.code)).toEqual(['update_suspended', 'update_suspended'])
    expect(paused[0].error.message).toContain('업데이트를 눌러')
    await electronApp.evaluate(() => { (globalThis as typeof globalThis & { probeMode?: string }).probeMode = 'success' })
    expect(await probe()).toEqual([
      { result: { installed: true, connected: true, version: null, detail: '' } },
      { result: { installed: true, connected: true, version: null, detail: '' } }
    ])
    await electronApp.evaluate(() => { (globalThis as typeof globalThis & { probeMode?: string }).probeMode = 'error' })
    expect(await probe()).toEqual([{ error: { code: 'chat', message: '실제 로그인 실패' } }, { error: { code: 'chat', message: '실제 로그인 실패' } }])
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { attempts?: number }).attempts)).toBe(6)
  } finally { await electronApp.close() }
})

test('app update progress remains reachable after closing the named dialog', async () => {
  const { electronApp, page } = await launch({ env: { KNUAF_AGENT_PATH_ONLY: '1', PATH: '/usr/bin:/bin' } })
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app-update:cancel')
      ipcMain.handle('app-update:cancel', () => {
        const g = globalThis as typeof globalThis & { cancelled?: number }
        g.cancelled = (g.cancelled ?? 0) + 1
        return { result: true }
      })
    })
    const emit = (phase: string) => electronApp.evaluate(({ BrowserWindow }, phase) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app-update:status', {
        phase, current: '0.5.1', latest: '0.6.0', page: 'https://github.com/knuaf-devcat/knuaf-dev/releases/tag/v0.6.0', received: 30, total: 100
      })
    }, phase)
    await emit('available')
    const titleButton = page.locator('.titlebar').getByRole('button', { name: '업데이트', exact: true })
    await titleButton.click()
    const dialog = page.getByRole('dialog', { name: '새 앱 0.6.0이 나왔어요' })
    await expect(dialog).toBeVisible()
    await emit('downloading')
    await expect(dialog).toContainText('앱을 받고 있어요 30%')
    await dialog.getByRole('button', { name: '나중에' }).click()
    await expect(titleButton).toBeVisible()
    await titleButton.click()
    await expect(dialog.getByRole('button', { name: '취소' })).toBeVisible()
    await dialog.getByRole('button', { name: '취소' }).click()
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { cancelled?: number }).cancelled)).toBe(1)
    await dialog.getByRole('button', { name: '나중에' }).click()
    await navTo(page, '설정')
    const section = page.getByRole('region', { name: '업데이트' })
    await expect(section).toContainText('앱을 받고 있어요')
    await emit('preparing')
    await expect(section).toContainText('앱 설치를 준비하고 있어요')
    await page.locator('dialog[data-screen="settings"] > .sheet-head button[aria-label="닫기"]').click()
    await titleButton.click()
    await expect(dialog.getByRole('button', { name: '취소' })).toBeVisible()
    await emit('launching')
    await expect(dialog).toContainText('앱 설치를 시작하고 있어요')
    await expect(dialog.getByRole('button', { name: '취소' })).toHaveCount(0)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.screenshot({ path: resolve(__dirname, '..', '..', '..', 'w3-work', `fix1-launching-${colorScheme}.png`) })
    }
    await dialog.getByRole('button', { name: '나중에' }).click()
    await navTo(page, '설정')
    await expect(section).toContainText('앱 설치를 시작하고 있어요')
  } finally { await electronApp.close() }
})
