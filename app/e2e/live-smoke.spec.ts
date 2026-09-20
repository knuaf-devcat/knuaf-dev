// KNUAF_LIVE=1 전용 실기기 스모크 — 목 테스트가 놓친 계층을 검증한다:
// 실제 `codex app-server`와 Claude Agent SDK를 띄워 핸드셰이크와 첫 프롬프트 도달을 본다.
// (지난 회귀 두 건이 여기서 왔다 — app-server `--listen` 인자 폐기, 가변 `--disallowedTools`가
//  첫 프롬프트를 삼킴. 둘 다 인자 배열의 "모양"만 단언해 초록이었다.)
// 전제: 이 기기에 ChatGPT 로그인 · Claude 구독 로그인. 미충족 provider는 skip된다.
// 실제 구독 사용량을 쓰므로 playwright.config의 `live-*` 패턴으로 평시 CI에서 제외된다.
import { expect, test } from '@playwright/test'
import { launch, openProject, synthProject } from './helpers'
import type { ChatSnapshot, Provider } from '../src/shared/chat'

test.setTimeout(300_000)

const status = async (page: any, root: string, provider: Provider) => page.evaluate(async ([rt, p]) => {
  const x = await window.knuaf.chat.status(rt, p); return 'result' in x ? x.result : null
}, [root, provider] as const)

const snap = async (page: any, root: string, provider: Provider): Promise<ChatSnapshot | null> => page.evaluate(async ([rt, p]) => {
  const x = await window.knuaf.chat.snapshot(rt, p); return 'result' in x ? x.result : null
}, [root, provider] as const)

/** 핸드셰이크(세션 확보) + 첫 프롬프트 도달(assistant 말풍선)만 본다 — 전체 면담은 live-*-verify가 커버. */
async function firstPromptDelivered(page: any, root: string, provider: Provider) {
  const st = await status(page, root, provider)
  test.skip(!st?.installed, `${provider} CLI 미설치 — live 스모크는 실제 바이너리가 필요하다`)
  test.skip(!st?.connected, `${provider} 계정 로그인 필요 — live 스모크는 실제 세션이 필요하다`)
  const sendError = await page.evaluate(async ([rt, p]) => {
    const x = await window.knuaf.chat.send(rt, p, '연결 점검이에요. "연결됐어요"라고만 짧게 답해 주세요.', crypto.randomUUID())
    return 'error' in x ? x.error.message : null
  }, [root, provider] as const)
  expect(sendError).toBeNull()
  let last: ChatSnapshot | null = null
  await expect.poll(async () => {
    last = await snap(page, root, provider)
    if (last?.state === 'error') throw new Error(`도우미 오류: ${last.error}`)
    return last?.messages.some((m) => m.role === 'assistant') ?? false
  }, { timeout: 240_000, intervals: [2000] }).toBe(true)
  expect(last!.sessionId, '핸드셰이크로 세션 id를 받아야 한다').toBeTruthy()
  expect(last!.messages.find((m) => m.role === 'user')!.delivery).toBe('sent')
}

test('live smoke: codex 채팅 핸드셰이크 + 첫 프롬프트', async () => {
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await firstPromptDelivered(page, root, 'codex')
  } finally { await electronApp.close() }
})

test('live smoke: claude 채팅(SDK) 핸드셰이크 + 첫 프롬프트', async () => {
  const root = synthProject({ withContent: false })
  const { electronApp, page } = await launch()
  try {
    await openProject(page, root)
    await firstPromptDelivered(page, root, 'claude')
  } finally { await electronApp.close() }
})
