// **설치본**(dmg → /Applications) 전용 시험.
//
// 개발 빌드 e2e(`app/e2e`)와 일부러 따로 둔다. 여기서만 참이어야 하는 것은 "저장소 체크아웃이
// 아니라 **번들 안의 리소스**로 돈다"는 사실이다 — 동봉 python, 동봉 스킬 스크립트, 동봉
// 사이드카, 오프라인 휠, 첫 실행, userData 자리, 창이 뜨는지.
//
// 여기서 **다루지 않는 것**(형님 맥 몫, 발주 ①):
//   진짜 ChatGPT/Claude 로그인 · 진짜 AI 답변 · Word/Excel 자동화 · 한글 입력 · Gatekeeper 경고.
//   CI 러너가 내려받은 적 없는 dmg 를 풀어 쓰므로 격리 표시(com.apple.quarantine)가 없고,
//   그래서 Gatekeeper 는 이 자리에서 재현되지 않는다.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { bundle, bundledProject, launchInstalled, seededUserData } from './launch-installed'
import { openProject, paperReady } from '../e2e/helpers'
import { APP_NAME } from '../src/shared/name'

/** 첫 실행 화면의 1단계 문구 — `copy.ts` 의 `ONBOARD.connectTitle` 과 같다. */
const FIRST_RUN = 'text=먼저, 쓰고 있는 AI를 연결해요'

/** 이 저장소의 앱 버전 — 설치본이 낡은 빌드면 여기서 갈린다. */
function repoVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
  if (!pkg || typeof pkg !== 'object' || !('version' in pkg) || typeof pkg.version !== 'string') {
    throw new Error('package.json 에서 version 을 읽지 못했다')
  }
  return pkg.version
}

test('처음 켜면 첫 실행 화면이 뜨고, 동봉 리소스가 앱 안에 있다', async () => {
  const b = bundle()
  // userData 를 넘기지 않는다 — 학생의 첫 실행과 같은 자리(앱이 스스로 고르는 폴더)를 본다.
  // 첫 실행 화면은 **크롬(제목줄) 없이** 뜬다(`Onboarding` 은 `Shell` 밖이다) — 그래서 준비
  // 신호가 `.titlebar` 가 아니라 그 화면 자신(`.onb`)이다.
  const { electronApp, page } = await launchInstalled({ userData: null, waitFor: '.onb' })
  try {
    const info = await page.evaluate(() => window.knuaf.appInfo())
    // ① 설치본으로 돌고 있다(개발 트리 `out/main/index.js` 가 아니다).
    expect(info.packaged).toBe(true)
    expect(info.version).toBe(repoVersion())
    // ② 첫 실행의 userData 자리는 표시이름(productName) 폴더다 — 여기가 어긋나면 학생의
    //    설정·최근 폴더가 매번 새로 시작한다.
    expect(info.userData).toBe(join(homedir(), 'Library', 'Application Support', 'knuaf-dev'))
    // ③ 첫 실행 화면(온보딩 1단계). 개발 빌드 e2e 는 늘 `onboarded_at` 을 심고 보므로,
    //    이 화면이 실제로 뜨는지 보는 곳은 여기뿐이다.
    await expect(page.locator(FIRST_RUN)).toBeVisible({ timeout: 60_000 })
    // ④ 창이 떴다(숨김 실행이어도 창 객체와 렌더는 살아 있다).
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

    // ⑤ 번들 리소스 — 설치본이 읽는 자리 그대로(`python.ts`·`runtime.ts` 의 packaged 분기).
    for (const p of [
      b.python,
      join(b.scripts, 'gg.py'),
      join(b.scripts, 'gg_core.py'),
      join(b.scripts, 'build_docx.py'),
      join(b.scripts, 'requirements-runtime.txt'),
      join(b.sidecar, 'knuaf_sidecar', '__main__.py'),
      join(b.docs, 'student-guide.pdf'),
      join(b.docs, 'student-guide.html')
    ]) expect(existsSync(p), `번들에 없다: ${p}`).toBe(true)
    // 동봉 python 은 **실행되는 바이너리**여야 한다(파일 존재만으로는 부족하다).
    expect(execFileSync(b.python, ['-V'], { encoding: 'utf-8' }).trim()).toMatch(/^Python 3\.\d+/)
    expect(statSync(b.python).mode & 0o111, '동봉 python 에 실행 권한이 없다').not.toBe(0)

    // ⑥ 오프라인 휠 — 러너가 인터넷 없이도 프로젝트 venv 를 만들 수 있어야 한다.
    const wheels = readdirSync(b.wheelhouse).filter((f) => f.endsWith('.whl'))
    for (const dist of ['openpyxl', 'python_docx', 'pypdf']) {
      expect(wheels.some((w) => w.startsWith(dist)), `${dist} 휠이 없다: ${wheels.join(', ')}`).toBe(true)
    }

    // ⑦ 실행기 선택이 **번들**로 떨어진다 — 개발 트리 경로가 아니라 앱 안의 python·스킬.
    const sc = await page.evaluate(() => window.knuaf.sidecarInfo())
    expect(sc.basePython).toBe(b.python)
    expect(sc.wheelhouse).toBe(b.wheelhouse)
    expect(sc.scriptsDir).toBe(b.scripts)
  } finally {
    await electronApp.close()
  }
})

test('동봉 python·스킬로 폴더를 열면 사이드카가 붙고 종이가 뜬다', async () => {
  const b = bundle()
  // 폴더도 **동봉 python + 동봉 gg.py** 로 만든다 — 저장소의 .venv-dev 를 쓰지 않는다.
  const root = bundledProject()
  const { electronApp, page } = await launchInstalled({ userData: seededUserData() })
  try {
    // 이 시험이 개발 트리 우회로 도는 게 아님을 먼저 못 박는다.
    expect(await electronApp.evaluate(() => process.env.KNUAF_PYTHON ?? null)).toBeNull()
    expect(await electronApp.evaluate(() => process.env.KNUAF_SCRIPTS_DIR ?? null)).toBeNull()

    await openProject(page, root, (p) => paperReady(p, '600평'))

    const sc = await page.evaluate(() => window.knuaf.sidecarInfo())
    expect(sc.running, '사이드카가 떠 있지 않다').toBe(true)
    expect(sc.kind, '동봉 python 이 아니라 다른 실행기를 골랐다').toBe('bundled')
    expect(sc.python).toBe(b.python)
    expect(sc.scriptsDir).toBe(b.scripts)

    // 창 제목이 열린 폴더 이름을 단다 — 설치본에서도 main 이 같은 경로를 탄다.
    // (`page.title()` 이 아니라 창 제목을 본다: 문서 제목은 `index.html` 의 정적 값이라
    //  main 이 세우는 창 제목과 다른 출처다.)
    const title = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
    expect(title).toBe(`${basename(root)} — ${APP_NAME}`)
  } finally {
    await electronApp.close()
  }
})
