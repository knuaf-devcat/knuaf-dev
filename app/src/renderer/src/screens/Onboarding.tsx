import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useProject } from '../store/project'
import { displayState, useConnect, type ConnInfo, type ConnState } from '../store/connect'
import type { ChatMode } from '../store/chat'
import { Badge } from '../components/Badge'
import { Feedback } from '../components/Feedback'
import { ProjectCard } from '../components/ProjectCard'
import { PRIVACY_NOTE, CHAT, EMPTY, relativeTime, type DescribedError } from '../copy'
import { NAME, ONBOARD, stateLine } from '../copy-onboarding'
import type { Provider } from '../../../shared/chat'
import type { ProjectPeek, RecentEntry } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/**
 * 첫 실행 화면 — AI 연결 ① → 논문 폴더 ② (DESIGN §6, IMPL-PLAN §4-3).
 *
 * 순서를 뒤집은 이유: 이 앱의 주 작업이 AI 인터뷰이고, 연결은 CLI 전역 계정의 사실이라
 * 논문 폴더와 무관하다. 폴더를 고르기 전에 AI 가 준비됐는지부터 보여 주면 학생은 아직
 * 필요하지 않은 결정(어느 폴더에 쓸까)을 하기 전에 막힐 곳을 먼저 본다.
 *
 * 두 결정을 한 화면에 겹쳐 묻지 않는다(R5 §3 "한 번에 한 결정"). 여기에는 모델·논문 제목·
 * 저장 경로가 없다 — 계정 준비 이전에 그것을 묻지 말라는 것이 조사의 결론이다.
 *
 * 문구는 copy-onboarding.ts 에 있다(왜 거기 있는지는 그 파일 첫 주석).
 *
 * 스타일도 같은 이유로 인라인이다 — 화면 전용 클래스는 합류 뒤 styles/ 에 넣는다. 버튼은
 * 전부 기본(테두리) 버튼이다: "채운 버튼은 보내기 하나" 규칙(DESIGN §7)을 지키기 위해 `primary`
 * 를 쓰지 않는다. 시안의 소프트 코발트 클래스도 단계 1 의 토큰 교체와 함께 오면 그때
 * 앞으로 가는 단추 하나에만 붙인다(1단계: 다음 / 2단계: 새 폴더 만들기).
 */
const MODE: Record<Provider, ChatMode> = { codex: 'codex-chat', claude: 'claude-chat' }

export function Onboarding({ onDone }: { onDone?: () => void }) {
  const { settings, loadSettings, open, loading, error, clearError } = useProject(useShallow((s) => ({
    settings: s.settings, loadSettings: s.loadSettings, open: s.open, loading: s.loading, error: s.error, clearError: s.clearError
  })))
  const { codex, claude, selected, loggingIn, select, refreshAll, refresh, login, cancel, reopen, stopPolling } = useConnect(useShallow((s) => ({
    codex: s.codex, claude: s.claude, selected: s.selected, loggingIn: s.loggingIn, select: s.select,
    refreshAll: s.refreshAll, refresh: s.refresh, login: s.login, cancel: s.cancel, reopen: s.reopen, stopPolling: s.stopPolling
  })))
  const [step, setStep] = useState<'connect' | 'folder'>('connect')
  const [peeks, setPeeks] = useState<Record<string, ProjectPeek>>({})
  const [openErr, setOpenErr] = useState<DescribedError | null>(null)
  const [rechecking, setRechecking] = useState<Provider | null>(null)
  /** 로그인을 시킨 공급자 — 그 로그인이 성공하면 그 선택을 기록한다(로그인 자체가 선택이다). */
  const loginTarget = useRef<Provider | null>(null)
  /** 건너뛰기 판정은 한 번만 한다 — 상태가 오갈 때마다 화면이 튀지 않게. */
  const settled = useRef(false)
  const choice = settings?.provider_choice ?? null

  const info = (p: Provider): ConnInfo => (p === 'codex' ? codex : claude)
  const stateOf = (p: Provider): ConnState => displayState(info(p), loggingIn[p])

  useEffect(() => { void refreshAll(); return () => stopPolling() }, [refreshAll, stopPolling])

  /**
   * 학생이 고른 순간을 여기서 기록한다. `helper_mode` 도 같이 적는 이유: 합류 전까지 대화
   * 공급자는 `helper_mode` 를 따라간다(store/chat.ts 는 단계 1 소유라 지금은 못 고친다).
   * `provider_choice` 가 "고른 적 있음"의 기록이고, 기본값이 채워지는 `helper_mode` 와 다르다.
   */
  const remember = async (p: Provider) => {
    await window.knuaf.setSettings({ helper_mode: MODE[p], provider_choice: { provider: p, at: new Date().toISOString() } })
    await loadSettings()
    select(p)
  }

  // 고른 적이 있고 그 공급자가 연결돼 있으면 ①을 건너뛴다(IMPL-PLAN §4-3 건너뛰기 규칙).
  // stateOf 는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다 — 판정은 settled 로 한 번뿐이다.
  useEffect(() => {
    if (settled.current || !choice) return
    const st = stateOf(choice.provider)
    if (st === 'checking') return
    settled.current = true
    if (st === 'connected') { select(choice.provider); setStep('folder') }
  }, [choice, codex, claude, loggingIn])

  // 로그인이 끝나면 그 공급자를 고른 것으로 기록한다.
  useEffect(() => {
    const target = loginTarget.current
    if (!target || stateOf(target) !== 'connected') return
    loginTarget.current = null
    void remember(target)
  }, [codex, claude, loggingIn])

  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Record<string, ProjectPeek> = {}
      for (const r of settings?.recent ?? []) out[r.root] = await window.knuaf.peekProject(r.root)
      if (alive) setPeeks(out)
    })()
    return () => { alive = false }
  }, [settings?.recent])

  const pickFolder = async () => { const dir = await window.knuaf.pickFolder(); if (dir) await openFolder(dir) }
  const openFolder = async (dir: string) => {
    setOpenErr(null); clearError()
    const err = await open(dir, { local: true })
    if (err) { setOpenErr(err); return }
    // 여기까지 왔으면 첫 실행 화면을 지났다. 기록하고 앱 화면으로 넘긴다.
    await window.knuaf.setSettings({ onboarded_at: new Date().toISOString() })
    await loadSettings()
    onDone?.()
  }
  const removeRecent = async (r: string) => {
    await window.knuaf.setSettings({ recent: (settings?.recent ?? []).filter((x) => x.root !== r) })
    await loadSettings()
  }
  const recheck = async (p: Provider) => { setRechecking(p); await refresh(p); setRechecking(null) }
  const startLogin = async (p: Provider) => { loginTarget.current = p; await login(p) }
  const rows: Provider[] = ['codex', 'claude']
  /**
   * 길잡이 — 번호 원 없이 한 줄(DESIGN §6). 지금 하는 단계만 진하게, 지난 단계는 ✓ 로
   * 끝난 것을 말한다. `start` 는 늘 뒤에 오는 말이라 진해지지 않는다.
   */
  const mark = (part: 'connect' | 'folder' | 'start'): CSSProperties => ({ color: part === step ? 'var(--ink)' : undefined, fontWeight: part === step ? 600 : 500 })

  return (
    <div style={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div className="drag-strip" aria-hidden="true" />
      {/* margin:auto 로 가운데 선다 — 내용이 길어지면(폴더 목록) 그대로 스크롤된다. */}
      <div style={{ maxWidth: 620, width: '100%', margin: 'auto', padding: 'calc(var(--titlebar-h) + var(--sp-4)) var(--sp-5) var(--sp-10)' }}>
        <div className="caption" style={{ marginBottom: 'var(--sp-5)' }}>
          <strong style={mark('connect')}>{step === 'folder' ? ONBOARD.guideConnectDone : ONBOARD.guideConnect}</strong>
          <span> → </span>
          <strong style={mark('folder')}>{ONBOARD.guideFolder}</strong>
          <span> → </span>
          <strong style={mark('start')}>{ONBOARD.guideStart}</strong>
        </div>

        {step === 'connect' ? (
          <>
            <h1>{ONBOARD.connectTitle}</h1>
            <p className="caption" style={{ margin: 'var(--sp-2) 0 var(--sp-5)' }}>{ONBOARD.connectIntro}</p>

            <div className="list">
              {rows.map((p) => {
                const st = stateOf(p)
                const bad = st === 'failed' || st === 'unknown'
                return (
                  <div className="item" key={p}>
                    <div className="head">
                      <div>
                        <span style={{ fontWeight: 600 }}>{NAME[p]}</span>
                        {p === 'codex' && <span style={{ marginLeft: 'var(--sp-2)' }}><Badge tone="accent" label={ONBOARD.recommended} /></span>}
                        {p === 'claude' && <span className="caption" style={{ marginLeft: 'var(--sp-2)' }}>{ONBOARD.claudeExperimental}</span>}
                        <div className="reason caption">{stateLine(p, st)}{st === 'connected' && p === selected ? ONBOARD.chosenSuffix : ''}</div>
                      </div>
                      <div className="row">
                        {st === 'no-tool' && <button onClick={() => void window.knuaf.openGuide()}>{ONBOARD.installGuide}</button>}
                        {st === 'need-login' && <button onClick={() => void startLogin(p)}>{ONBOARD.loginAs(NAME[p])}</button>}
                        {st === 'logging-in' && <>
                          <button onClick={() => void reopen(p)}>{ONBOARD.reopenBrowser}</button>
                          <button className="quiet" onClick={() => void cancel(p)}>{ONBOARD.cancel}</button>
                        </>}
                        {st === 'connected' && selected !== p &&
                          <button onClick={() => void remember(p).then(() => setStep('folder'))}>{ONBOARD.startWith}</button>}
                        <button className="quiet" onClick={() => void recheck(p)} disabled={rechecking === p || st === 'checking' || st === 'logging-in' || st === 'connected'}>{CHAT.recheck}</button>
                      </div>
                    </div>
                    {st === 'no-tool' && <div className="reason caption">{ONBOARD.toolHint}</div>}
                    {bad && info(p).detail && <div className="reason caption">{info(p).detail}</div>}
                  </div>
                )
              })}
            </div>

            <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
              {/* 소프트 코발트 클래스가 아직 없다(단계 1 의 토큰·스타일 교체와 함께 온다).
                  `primary` 는 채운 버튼이라 보내기 자리에만 쓴다는 규칙을 여기서도 지킨다. */}
              <button disabled={!selected} onClick={() => setStep('folder')}>{ONBOARD.connectNext}</button>
              {!selected && <span className="caption">{ONBOARD.connectWaiting}</span>}
            </div>
            <p className="caption" style={{ marginTop: 'var(--sp-5)' }}>{PRIVACY_NOTE}</p>
            <button className="quiet" onClick={() => void window.knuaf.openGuide()}>{ONBOARD.howToChoose}</button>
          </>
        ) : (
          <>
            <h1>{ONBOARD.folderTitle}</h1>
            <p className="caption" style={{ margin: 'var(--sp-2) 0 var(--sp-5)' }}>{ONBOARD.folderIntro}</p>

            {error && <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>} />}
            {openErr && <Feedback kind={openErr.kind} title={openErr.title} body={openErr.action} details={<code>{openErr.raw}</code>} />}

            <div className="list">
              <div className="item"><div className="head">
                <div>
                  <div style={{ fontWeight: 600 }}>{ONBOARD.newName}</div>
                  <div className="reason caption">{ONBOARD.newBody}</div>
                </div>
                <button onClick={() => void pickFolder()} disabled={loading}>{ONBOARD.newAction}</button>
              </div></div>
              <div className="item"><div className="head">
                <div>
                  <div style={{ fontWeight: 600 }}>{ONBOARD.recentName}</div>
                  <div className="reason caption">{ONBOARD.recentBody}</div>
                </div>
                <button onClick={() => void pickFolder()} disabled={loading}>{ONBOARD.recentAction}</button>
              </div></div>
            </div>

            <h2 style={{ marginTop: 'var(--sp-6)', fontSize: 'var(--fs-caption)' }}>{ONBOARD.recents}</h2>
            {(settings?.recent ?? []).length === 0
              ? <p className="caption">{EMPTY.recent.title}</p>
              : <div className="projects stagger">
                {(settings?.recent ?? []).map((r: RecentEntry, i) => {
                  const p = peeks[r.root]
                  return (
                    <ProjectCard key={r.root} index={i} root={r.root} openedAt={relativeTime(r.opened_at)} revision={p?.revision ?? null}
                      exists={p ? p.exists : true} hasProject={p?.hasProject ?? false}
                      onOpen={() => void openFolder(r.root)} onRemove={() => void removeRecent(r.root)} />
                  )
                })}
              </div>}

            <div className="row" style={{ marginTop: 'var(--sp-6)' }}>
              <button className="quiet" onClick={() => setStep('connect')}>{ONBOARD.folderBack}</button>
              <span className="caption">{ONBOARD.folderFoot}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
