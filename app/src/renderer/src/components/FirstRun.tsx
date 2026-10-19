import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { displayState, useConnect, canAdvance, type ConnInfo, type ConnState } from '../store/connect'
import type { ChatMode } from '../store/chat'
import { FolderPicker } from './FolderPicker'
import { ConnectBadges, ConnectRow } from './ConnectRow'
import { Feedback } from './Feedback'
import { RuntimeFix } from './RuntimeFix'
import { CLOSE_LABEL, FOLDER, ONBOARD, PRIVACY_NOTE, RUNTIME } from '../copy'
import type { Provider } from '../../../shared/chat'
import { useShallow } from 'zustand/react/shallow'

/**
 * 첫 화면 두 단계 — AI 연결 ① → 논문 폴더 ② (DESIGN §6, IMPL-PLAN §4-3).
 *
 * 순서를 뒤집은 이유: 이 앱의 주 작업이 AI 인터뷰이고, 연결은 CLI 전역 계정의 사실이라
 * 논문 폴더와 무관하다. 폴더를 고르기 전에 AI 가 준비됐는지부터 보여 주면 학생은 아직
 * 필요하지 않은 결정(어느 폴더에 쓸까)을 하기 전에 막힐 곳을 먼저 본다.
 *
 * **두 자리가 같은 것을 쓴다**(발주 QA 재실행 결정): 첫 실행 화면(크롬 없이 가운데 한 줄기)과
 * 재실행 첫 화면(제목줄이 있는 대화 칸 안)이 이 부품 하나를 공유한다. 재실행에서 연결이
 * 끊겨 있으면 같은 건너뛰기 규칙이 자연히 1단계(AI 연결)를 먼저 보여 준다. 두 벌로 두면
 * 한쪽만 고쳐지고, 같은 사실이 두 모양으로 보인다.
 *
 * 두 결정을 한 화면에 겹쳐 묻지 않는다(R5 §3 "한 번에 한 결정"). 모델·논문 제목·저장 경로·
 * 번호 원 스테퍼가 없다. 2단계의 폴더 고르기는 `FolderPicker` 를 쓴다 — 재방문 화면과 같은 부품이다.
 */
const MODE: Record<Provider, ChatMode> = { codex: 'codex-chat', claude: 'claude-chat' }
const ROWS: Provider[] = ['codex', 'claude']

export function FirstRun({ onFolderOpened }: { onFolderOpened?: (root: string) => void | Promise<void> }) {
  const { settings, loadSettings, error, openFailure, retryFailed, clearError, retryOpen } = useProject(useShallow((s) => ({
    settings: s.settings, loadSettings: s.loadSettings, error: s.error, openFailure: s.openFailure,
    retryFailed: s.retryFailed, clearError: s.clearError, retryOpen: s.retryOpen
  })))
  const { codex, claude, selected, loggingIn, select, refreshAll, stopPolling } = useConnect(useShallow((s) => ({
    codex: s.codex, claude: s.claude, selected: s.selected, loggingIn: s.loggingIn, select: s.select,
    refreshAll: s.refreshAll, stopPolling: s.stopPolling
  })))
  const [step, setStep] = useState<'connect' | 'folder'>('connect')
  /**
   * 로그인을 시작한 공급자들 — 그 로그인이 성공하면 그중 하나가 선택 후보가 된다.
   * 하나가 아니라 **집합**인 이유(W2 D3, R1-D02): 선택 없이 둘을 연달아 로그인하면,
   * 단일 값이던 시절에는 마지막에 시작한 쪽만 성공을 알아채 다른 쪽 성공이 버려졌다.
   */
  const loginTargets = useRef<Set<Provider>>(new Set())
  /** 선택 확정(비동기 설정 쓰기 + 재조회)이 도는 동안 — 두 성공이 겹쳐 두 번 저장하지 않게. */
  const confirming = useRef(false)
  /** 건너뛰기 판정은 한 번만 한다 — 상태가 오갈 때마다 화면이 튀지 않게. */
  const settled = useRef(false)
  /**
   * **처음 이 화면을 열 때 있던** 선택. 이 세션에서 방금 고른 것(로그인·[이걸로 시작])은 여기
   * 들어가지 않는다 — 그때는 설계대로 [다음 — 논문 폴더 고르기]를 학생이 누른다.
   */
  const storedChoice = useRef<Provider | null>(settings?.provider_choice?.provider ?? null)

  const info = (p: Provider): ConnInfo => (p === 'codex' ? codex : claude)
  const stateOf = (p: Provider): ConnState => displayState(info(p), loggingIn[p])

  useEffect(() => { void refreshAll(); return () => stopPolling() }, [refreshAll, stopPolling])

  /**
   * 학생이 고른 순간을 여기서 기록한다. `helper_mode` 는 화면 표시용 기본값이고,
   * `provider_choice` 가 "고른 적 있음"의 기록이다(IMPL-R1-02).
   */
  const remember = async (p: Provider): Promise<void> => {
    await window.knuaf.setSettings({ helper_mode: MODE[p], provider_choice: { provider: p, at: new Date().toISOString() } })
    await loadSettings()
    select(p)
  }

  /**
   * 1단계를 건너뛰는 조건(W2 D2, R1-D01): 저장된 선택이 연결돼 있고 **다른 공급자도** 연결돼
   * 있을 때만. 하나만 연결돼 있으면 이 화면에 남는다 — 둘 다 연결하려는 학생에게서 다른 쪽
   * 로그인 단추를 빼앗지 않는다.
   *
   * 판정은 **양쪽의 최초 확인이 모두 끝난 뒤 한 번**이다. 저장된 쪽 응답만 먼저 와서 판정하면
   * 같은 입력이 조회 순서에 따라 다른 화면이 된다(설계 검토 R1-D01).
   */
  useEffect(() => {
    const stored = storedChoice.current
    if (settled.current || !stored) return
    if (stateOf('codex') === 'checking' || stateOf('claude') === 'checking') return
    settled.current = true
    const other: Provider = stored === 'codex' ? 'claude' : 'codex'
    if (canAdvance(stored, stateOf) && stateOf(other) === 'connected') { select(stored); setStep('folder') }
  }, [codex, claude, loggingIn])

  /**
   * 로그인이 끝나면 그 공급자를 고른 것으로 기록한다 — 단, **아직 연결된 선택이 없을 때만**
   * (W2 D3). 이미 연결된 공급자를 골라 둔 상태에서 다른 쪽을 추가로 연결하면 선택은 그대로
   * 두고 그 행에 "이걸로 시작"이 뜬다. 두 번째 연결이 학생 모르게 대화 공급자를 바꾸지 않는다.
   *
   * 후보는 공급자별로 모으고(동시 로그인), 끝난 후보(연결·실패·취소)는 지운다. 두 성공이
   * 겹치면 먼저 성공한 쪽이 확정된다 — `confirming` 이 중복 저장을 막는다.
   */
  useEffect(() => {
    const candidates = loginTargets.current
    if (!candidates.size) return
    const connected = [...candidates].filter((p) => stateOf(p) === 'connected')
    for (const p of [...candidates]) {
      if (connected.includes(p)) continue
      if (!loggingIn[p] && stateOf(p) !== 'checking') candidates.delete(p)   // 실패·취소로 끝난 후보
    }
    if (!connected.length || confirming.current) return
    for (const p of connected) candidates.delete(p)
    if (selected && stateOf(selected) === 'connected') return   // 이미 연결된 선택은 보존한다
    confirming.current = true
    void remember(connected[0]).finally(() => { confirming.current = false })
  }, [codex, claude, loggingIn, selected])

  /**
   * 전진 조건은 하나다 — **고른 것이 지금 연결돼 있다**(P2-R1-03). 저장된 선택만 보고 넘어가면
   * 연결을 못 마친 첫 실행이 "AI 연결 완료"로 폴더 단계에 선다.
   */
  const advance = canAdvance(selected, stateOf)
  const connectDone = step === 'folder' && canAdvance(selected ?? storedChoice.current, stateOf)
  /** 지금 하는 단계만 진하게(나머지는 흐리게) — 길잡이 한 줄에서 "여기"를 표시한다. */
  const here = (part: 'connect' | 'folder' | 'start'): string => (part === step ? 'on' : '')

  return (
    <>
      {/* 메뉴(Finder·독)에서 폴더를 열다 실패한 경우 — 어느 단계에 있든 그 실패와 준비 버튼을
          여기서 한 번 보여 준다. FolderPicker 는 이 경우 같은 오류를 되풀이하지 않는다. */}
      {error && openFailure && error.code === openFailure.code && (
        <>
          {/* 설치 성공과 폴더 복구 실패를 함께 말한다 — 이 표시는 store 가 들고 있어 재시도로
              이 화면이 다시 그려져도 남는다(§7). */}
          {retryFailed && <Feedback kind="warning" title={RUNTIME.retryFailedTitle} body={RUNTIME.retryFailedBody} />}
          <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>}
            actions={<button onClick={clearError}>{CLOSE_LABEL}</button>} />
          <RuntimeFix failure={openFailure} onRetry={async () => retryOpen(openFailure.root, onFolderOpened)} />
        </>
      )}
      {/* 길잡이 — 번호 원 없이 한 줄(DESIGN §6). 지난 단계는 ✓ 로 끝난 것을 말한다. */}
      <div className="caption onb-way">
        <strong className={here('connect')}>{connectDone ? ONBOARD.guideConnectDone : ONBOARD.guideConnect}</strong>
        <span> → </span>
        <strong className={here('folder')}>{ONBOARD.guideFolder}</strong>
        <span> → </span>
        <strong className={here('start')}>{ONBOARD.guideStart}</strong>
      </div>

      {step === 'connect' ? (
        <>
          <h1>{ONBOARD.connectTitle}</h1>
          <p className="caption" style={{ margin: 'var(--sp-2) 0 var(--sp-5)' }}>{ONBOARD.connectIntro}</p>

          {/* 선택 두 행은 한 테두리 안 + 가운데 구분선(시안 A, N-R01). */}
          <div className="choices">
            {ROWS.map((p) => (
              /* 상태 문구·행동 단추는 계정 팝오버와 **같은 부품**이다(ConnectRow). 여기서만
                 "권장/실험 중" 표시와 "이걸로 시작"이 붙는다. */
              <ConnectRow key={p} provider={p} badges={<ConnectBadges provider={p} />}
                onLogin={(who) => { loginTargets.current.add(who) }}
                suffix={stateOf(p) === 'connected' && p === selected ? ONBOARD.chosenSuffix : undefined}
                extra={stateOf(p) === 'connected' && selected !== p
                  ? { label: ONBOARD.startWith, run: () => void remember(p).then(() => setStep('folder')) }
                  : undefined} />
            ))}
          </div>

          <div className="row" style={{ marginTop: 'var(--sp-5)' }}>
            <button className="primary" disabled={!advance} onClick={() => setStep('folder')}>{ONBOARD.connectNext}</button>
            {!advance && <span className="caption">{ONBOARD.connectWaiting}</span>}
          </div>
          <p className="caption" style={{ marginTop: 'var(--sp-5)' }}>{PRIVACY_NOTE}</p>
          {/* 개인정보 줄 바로 아래 한 줄 — "둘 다 있나요?"는 보통 글자, 뒤만 링크다(시안 A). */}
          <p className="caption" style={{ marginTop: 'var(--sp-2)' }}>
            {ONBOARD.howToChooseLead}{' '}
            <button className="onb-help" onClick={() => void window.knuaf.openGuide()}>{ONBOARD.howToChooseLink}</button>
          </p>
        </>
      ) : (
        <>
          <FolderPicker
            copy={{ title: ONBOARD.folderTitle, intro: ONBOARD.folderIntro, ...FOLDER, foot: ONBOARD.folderFoot }}
            onOpened={onFolderOpened}
          />
          <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
            <button className="quiet" onClick={() => setStep('connect')}>{ONBOARD.folderBack}</button>
          </div>
        </>
      )}
    </>
  )
}
