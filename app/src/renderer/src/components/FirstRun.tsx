import { useEffect, useRef, useState } from 'react'
import { useProject } from '../store/project'
import { displayState, useConnect, canAdvance, type ConnInfo, type ConnState } from '../store/connect'
import type { ChatMode } from '../store/chat'
import { FolderPicker } from './FolderPicker'
import { ConnectBadges, ConnectRow } from './ConnectRow'
import { Feedback } from './Feedback'
import { RuntimeFix } from './RuntimeFix'
import { CLOSE_LABEL, FOLDER, ONBOARD, PRIVACY_NOTE } from '../copy'
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

export function FirstRun({ onFolderOpened }: { onFolderOpened?: (root: string) => void }) {
  const { settings, loadSettings, error, openFailure, clearError, open } = useProject(useShallow((s) => ({
    settings: s.settings, loadSettings: s.loadSettings, error: s.error, openFailure: s.openFailure, clearError: s.clearError, open: s.open
  })))
  const { codex, claude, selected, loggingIn, select, refreshAll, stopPolling } = useConnect(useShallow((s) => ({
    codex: s.codex, claude: s.claude, selected: s.selected, loggingIn: s.loggingIn, select: s.select,
    refreshAll: s.refreshAll, stopPolling: s.stopPolling
  })))
  const [step, setStep] = useState<'connect' | 'folder'>('connect')
  /** 로그인을 시킨 공급자 — 그 로그인이 성공하면 그 선택을 기록한다(로그인 자체가 선택이다). */
  const loginTarget = useRef<Provider | null>(null)
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

  // 고른 적이 있고 그 공급자가 연결돼 있으면 ①을 건너뛴다(IMPL-PLAN §4-3 건너뛰기 규칙).
  useEffect(() => {
    const stored = storedChoice.current
    if (settled.current || !stored) return
    if (stateOf(stored) === 'checking') return
    settled.current = true
    if (canAdvance(stored, stateOf)) { select(stored); setStep('folder') }
  }, [codex, claude, loggingIn])

  // 로그인이 끝나면 그 공급자를 고른 것으로 기록한다.
  useEffect(() => {
    const target = loginTarget.current
    if (!target || stateOf(target) !== 'connected') return
    loginTarget.current = null
    void remember(target)
  }, [codex, claude, loggingIn])

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
          <Feedback kind={error.kind} title={error.title} body={error.action} details={<code>{error.raw}</code>}
            actions={<button onClick={clearError}>{CLOSE_LABEL}</button>} />
          <RuntimeFix failure={openFailure} onRetry={async () => (await open(openFailure.root, { local: true })) === null} />
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
                onLogin={(who) => { loginTarget.current = who }}
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
