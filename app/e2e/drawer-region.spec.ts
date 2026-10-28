import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, openProject, synthProject } from './helpers'
import { fakeCodexEnv, scratch } from './fixtures/fake-codex'

test('제목줄 높이의 모든 조작은 끌기 영역에서 빠지고 서랍을 연다', async () => {
  const dir = scratch()
  const { electronApp, page } = await launch({ env: fakeCodexEnv(join(dir, 'bin')) })
  try {
    await openProject(page, synthProject())
    for (const platform of ['darwin', 'win32', 'linux']) {
      await page.evaluate((p) => { document.documentElement.dataset.platform = p }, platform)
      for (const width of [1024, 1366, 1370, 1440]) {
        await electronApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setBounds({ width: w, height: 800 }), width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        const controls = await page.evaluate(() => {
          const strip = document.querySelector('.drag-strip')!.getBoundingClientRect()
          return Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="tab"]'))
            .filter((el) => {
              const r = el.getBoundingClientRect()
              const style = getComputedStyle(el)
              return r.width > 0 && r.height > 0 && r.top < strip.bottom && r.bottom > strip.top && style.visibility === 'visible'
            })
            .map((el) => ({ label: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim(), region: getComputedStyle(el).getPropertyValue('-webkit-app-region') }))
        })
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.filter((c) => c.region !== 'no-drag'), `${platform} ${width}: ${JSON.stringify(controls)}`).toEqual([])
        const toggle = page.getByRole('button', { name: '프로젝트 목록', exact: true })
        if (width < 1370) {
          await expect(toggle).toBeVisible()
          await toggle.click()
          await expect(page.getByLabel('프로젝트', { exact: true })).toBeVisible()
          await page.getByRole('button', { name: '프로젝트 목록 닫기' }).click()
          await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        } else await expect(toggle).toBeHidden()
      }
    }
  } finally { await electronApp.close() }
})
