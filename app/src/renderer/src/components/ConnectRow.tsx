import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { displayState, useConnect, type ConnState } from '../store/connect'
import { CHAT, ONBOARD, PROVIDER_NAME, connectStateLine } from '../copy'
import type { Provider } from '../../../shared/chat'

/**
 * 연결 도구 한 줄 — 첫 실행 1단계와 제목줄 계정 팝오버가 **같은 것**을 쓴다(설계자 답 Q2).
 *
 * 상태 문구(`connectStateLine`)와 행동 단추(설치 안내 · 로그인 · 브라우저 다시 열기/취소 ·
 * 다시 확인)를 여기 한 곳에 두고, 두 화면은 **덧붙이는 것 하나**만 다르게 넘긴다:
 * 첫 실행은 "권장" 같은 표시, 계정 팝오버는 "○○로 바꾸기". 두 벌로 두면 한쪽만 고쳐지고,
 * 같은 사실(연결 상태)이 두 모양으로 보인다.
 *
 * 상태 갱신·로그인 폴링은 `store/connect` 그대로다 — 여기서 새 규칙을 만들지 않는다.
 */
export function ConnectRow({ provider, extra, current }: {
  provider: Provider
  /** 연결됐을 때만 보이는 이 화면 몫의 주 행동. */
  extra?: { label: string; run: () => void }
  /** 지금 이 공급자로 대화하고 있는가 — 계정 팝오버가 표시한다. */
  current?: boolean
}) {
  const { codex, claude, loggingIn, login, cancel, reopen, refresh } = useConnect(useShallow((s) => ({
    codex: s.codex, claude: s.claude, loggingIn: s.loggingIn, login: s.login, cancel: s.cancel, reopen: s.reopen, refresh: s.refresh
  })))
  const [busy, setBusy] = useState(false)
  const info = provider === 'codex' ? codex : claude
  const state: ConnState = displayState(info, loggingIn[provider])
  const bad = state === 'failed' || state === 'unknown'

  const recheck = async (): Promise<void> => { setBusy(true); await refresh(provider); setBusy(false) }

  return (
    <div className={`item${current ? ' cur' : ''}`} data-provider={provider}>
      <div className="head">
        <div>
          <span className="name">{PROVIDER_NAME[provider]}</span>
          <div className="reason caption">{connectStateLine(provider, state)}</div>
        </div>
        <div className="row">
          {state === 'no-tool' && <button onClick={() => void window.knuaf.openGuide()}>{ONBOARD.installGuide}</button>}
          {/* 소프트 코발트 = 주 행동(DESIGN §7). 로그인과 "○○로 바꾸기"가 그 자리다. */}
          {state === 'need-login' && <button className="primary" onClick={() => void login(provider)}>{ONBOARD.loginAs(PROVIDER_NAME[provider])}</button>}
          {state === 'logging-in' && <>
            <button onClick={() => void reopen(provider)}>{ONBOARD.reopenBrowser}</button>
            <button className="quiet" onClick={() => void cancel(provider)}>{ONBOARD.cancel}</button>
          </>}
          {state === 'connected' && extra && <button className="primary" onClick={extra.run}>{extra.label}</button>}
          {/* 다시 확인은 실제로 다시 볼 것이 있을 때만 — 확인 중·로그인 중·연결됨에는
              아무 일도 하지 않는 회색 단추만 남는다(시안 A 에도 없다). */}
          {(state === 'no-tool' || bad || state === 'need-login') &&
            <button className="quiet" onClick={() => void recheck()} disabled={busy}>{CHAT.recheck}</button>}
        </div>
      </div>
      {state === 'no-tool' && <div className="reason caption">{ONBOARD.toolHint}</div>}
      {bad && info.detail && <div className="reason caption">{info.detail}</div>}
    </div>
  )
}

