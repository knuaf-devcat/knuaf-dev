import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { displayState, useConnect, type ConnInfo, type ConnState } from '../store/connect'
import { useChat, type ChatMode } from '../store/chat'
import { Badge } from '../components/Badge'
import { FolderPicker } from '../components/FolderPicker'
import { CHAT, FOLDER, ONBOARD, PRIVACY_NOTE, PROVIDER_NAME, connectStateLine } from '../copy'
import type { Provider } from '../../../shared/chat'
import { useShallow } from 'zustand/react/shallow'

/**
 * 첫 실행 화면 — AI 연결 ① → 논문 폴더 ② (DESIGN §6, IMPL-PLAN §4-3).
 *
 * 순서를 뒤집은 이유: 이 앱의 주 작업이 AI 인터뷰이고, 연결은 CLI 전역 계정의 사실이라
 * 논문 폴더와 무관하다. 폴더를 고르기 전에 AI 가 준비됐는지부터 보여 주면 학생은 아직
 * 필요하지 않은 결정(어느 폴더에 쓸까)을 하기 전에 막힐 곳을 먼저 본다.
 *
 * 두 결정을 한 화면에 겹쳐 묻지 않는다(R5 §3 "한 번에 한 결정"). 여기에는 모델·논문 제목·
 * 저장 경로가 없고, 번호 원 스테퍼도 없다.
 *
 * 2단계의 폴더 고르기는 `FolderPicker` 를 쓴다 — 재방문(폴더 없음) 화면과 같은 부품이다.
 * 두 벌로 두면 한쪽만 고쳐지고, 학생에게 같은 일이 두 모양으로 보인다.
 */
const MODE: Record<Provider, ChatMode> = { codex: 'codex-chat', claude: 'claude-chat' }
const ROWS: Provider[] = ['codex', 'claude']

export function Onboarding({ onDone }: { onDone?: () => void }) {
  const { settings, loadSettings } = useProject(useShallow((s) => ({ settings: s.settings, loadSettings: s.loadSettings })))
  const { codex, claude, selected, loggingIn, select, refreshAll, refresh, login, cancel, reopen, stopPolling } = useConnect(useShallow((s) => ({
    codex: s.codex, claude: s.claude, selected: s.selected, loggingIn: s.loggingIn, select: s.select,
    refreshAll: s.refreshAll, refresh: s.refresh, login: s.login, cancel: s.cancel, reopen: s.reopen, stopPolling: s.stopPolling
  })))
  const [step, setStep] = useState<'connect' | 'folder'>('connect')
  const [rechecking, setRechecking] = useState<Provider | null>(null)
  /** 로그인을 시킨 공급자 — 그 로그인이 성공하면 그 선택을 기록한다(로그인 자체가 선택이다). */
  const loginTarget = useRef<Provider | null>(null)
  /** 건너뛰기 판정은 한 번만 한다 — 상태가 오갈 때마다 화면이 튀지 않게. */
  const settled = useRef(false)
  /**
   * **앱을 열 때 이미 있던** 선택. 이 세션에서 방금 고른 것(로그인·[이걸로 시작])은 여기
   * 들어가지 않는다 — 그때는 설계대로 [다음 — 논문 폴더 고르기]를 학생이 누른다.
   * 먼저 온 학생도 같은 흐름을 한 번 보는 것이 "한 번에 한 결정"에 맞다.
   */
  const storedChoice = useRef<Provider | null>(settings?.provider_choice?.provider ?? null)

  const info = (p: Provider): ConnInfo => (p === 'codex' ? codex : claude)
  const stateOf = (p: Provider): ConnState => displayState(info(p), loggingIn[p])

  useEffect(() => { void refreshAll(); return () => stopPolling() }, [refreshAll, stopPolling])

  /**
   * 학생이 고른 순간을 여기서 기록한다. `helper_mode` 는 화면 표시용 기본값이고,
   * `provider_choice` 가 "고른 적 있음"의 기록이다(IMPL-R1-02). 둘 다 적어 두면 옛 화면도
   * 같은 공급자를 본다.
   */
  const remember = async (p: Provider) => {
    await window.knuaf.setSettings({ helper_mode: MODE[p], provider_choice: { provider: p, at: new Date().toISOString() } })
    await loadSettings()
    select(p)
  }

  // 고른 적이 있고 그 공급자가 연결돼 있으면 ①을 건너뛴다(IMPL-PLAN §4-3 건너뛰기 규칙).
  // stateOf 는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다 — 판정은 settled 로 한 번뿐이다.
  useEffect(() => {
    const stored = storedChoice.current
    if (settled.current || !stored) return
    const st = stateOf(stored)
    if (st === 'checking') return
    settled.current = true
    if (st === 'connected') { select(stored); setStep('folder') }
  }, [codex, claude, loggingIn])

  // 로그인이 끝나면 그 공급자를 고른 것으로 기록한다.
  useEffect(() => {
    const target = loginTarget.current
    if (!target || stateOf(target) !== 'connected') return
    loginTarget.current = null
    void remember(target)
  }, [codex, claude, loggingIn])

  /**
   * 폴더가 열렸다 — 첫 실행 화면을 지났음을 기록하고, 그 폴더에서 첫 대화를 시작할 의사를
   * 남긴다(대화가 비어 있으면 Chat 이 한 번 보낸다). 여기서 보내지 않는 이유: 대화 화면이
   * 뜨기도 전에 보내면 그 응답을 받을 화면이 없다.
   */
  const opened = async (root: string) => {
    await window.knuaf.setSettings({ onboarded_at: new Date().toISOString() })
    useChat.getState().armStart(root)
    await loadSettings()
    onDone?.()
  }

  const recheck = async (p: Provider) => { setRechecking(p); await refresh(p); setRechecking(null) }
  const startLogin = async (p: Provider) => { loginTarget.current = p; await login(p) }
  /** 지금 하는 단계만 진하게(나머지는 흐리게) — 길잡이 한 줄에서 "여기"를 표시한다. */
  const here = (part: 'connect' | 'folder' | 'start'): string => (part === step ? 'on' : '')

  return (
    <div className="onb">
      <div className="drag-strip" aria-hidden="true" />
      <div className="onb-inner">
        {/* 길잡이 — 번호 원 없이 한 줄(DESIGN §6). 지난 단계는 ✓ 로 끝난 것을 말한다. */}
        <div className="caption onb-way">
          <strong className={here('connect')}>{step === 'folder' ? ONBOARD.guideConnectDone : ONBOARD.guideConnect}</strong>
          <span> → </span>
          <strong className={here('folder')}>{ONBOARD.guideFolder}</strong>
          <span> → </span>
          <strong className={here('start')}>{ONBOARD.guideStart}</strong>
        </div>

        {step === 'connect' ? (
          <>
            <h1>{ONBOARD.connectTitle}</h1>
            <p className="caption" style={{ margin: 'var(--sp-2) 0 var(--sp-5)' }}>{ONBOARD.connectIntro}</p>

            <div className="list">
              {ROWS.map((p) => {
                const st = stateOf(p)
                const bad = st === 'failed' || st === 'unknown'
                return (
                  <div className="item" key={p}>
                    <div className="head">
                      <div>
                        <span style={{ fontWeight: 600 }}>{PROVIDER_NAME[p]}</span>
                        {p === 'codex' && <span style={{ marginLeft: 'var(--sp-2)' }}><Badge tone="accent" label={ONBOARD.recommended} /></span>}
                        {p === 'claude' && <span className="caption" style={{ marginLeft: 'var(--sp-2)' }}>{ONBOARD.claudeExperimental}</span>}
                        <div className="reason caption">{connectStateLine(p, st)}{st === 'connected' && p === selected ? ONBOARD.chosenSuffix : ''}</div>
                      </div>
                      <div className="row">
                        {st === 'no-tool' && <button onClick={() => void window.knuaf.openGuide()}>{ONBOARD.installGuide}</button>}
                        {/* 소프트 코발트 = 주 행동(DESIGN §7). 로그인과 "이걸로 시작"이 그 자리다. */}
                        {st === 'need-login' && <button className="primary" onClick={() => void startLogin(p)}>{ONBOARD.loginAs(PROVIDER_NAME[p])}</button>}
                        {st === 'logging-in' && <>
                          <button onClick={() => void reopen(p)}>{ONBOARD.reopenBrowser}</button>
                          <button className="quiet" onClick={() => void cancel(p)}>{ONBOARD.cancel}</button>
                        </>}
                        {st === 'connected' && selected !== p &&
                          <button className="primary" onClick={() => void remember(p).then(() => setStep('folder'))}>{ONBOARD.startWith}</button>}
                        {/* 다시 확인은 실제로 다시 볼 것이 있을 때만 — 확인 중·로그인 중·연결됨에는
                            아무 일도 하지 않는 회색 단추만 남는다(시안 A 에도 없다). */}
                        {(st === 'no-tool' || st === 'failed' || st === 'unknown' || st === 'need-login') &&
                          <button className="quiet" onClick={() => void recheck(p)} disabled={rechecking === p}>{CHAT.recheck}</button>}
                      </div>
                    </div>
                    {st === 'no-tool' && <div className="reason caption">{ONBOARD.toolHint}</div>}
                    {bad && info(p).detail && <div className="reason caption">{info(p).detail}</div>}
                  </div>
                )
              })}
            </div>

            <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
              <button className="primary" disabled={!selected} onClick={() => setStep('folder')}>{ONBOARD.connectNext}</button>
              {!selected && <span className="caption">{ONBOARD.connectWaiting}</span>}
            </div>
            <p className="caption" style={{ marginTop: 'var(--sp-5)' }}>{PRIVACY_NOTE}</p>
            <button className="quiet" onClick={() => void window.knuaf.openGuide()}>{ONBOARD.howToChoose}</button>
          </>
        ) : (
          <>
            <FolderPicker
              copy={{ title: ONBOARD.folderTitle, intro: ONBOARD.folderIntro, ...FOLDER, foot: ONBOARD.folderFoot }}
              onOpened={(root) => void opened(root)}
            />
            <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
              <button className="quiet" onClick={() => setStep('connect')}>{ONBOARD.folderBack}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
