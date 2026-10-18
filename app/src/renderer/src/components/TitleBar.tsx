import { useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { ConnectRow } from './ConnectRow'
import { useProject } from '../store/project'
import { chosenProvider, displayState, useConnect } from '../store/connect'
import { chatProvider, resolveChatMode } from '../store/chat'
import { FOLDER, PROVIDER_NAME, TITLEBAR, relativeTime } from '../copy'
import { showsToggle, useLayout } from './useLayout'
import type { Provider } from '../../../shared/chat'
import { useShallow } from 'zustand/react/shallow'

/** 공급자 이름·상태 목록은 대화 화면과 같은 판정(`chosenProvider`)을 쓴다. */
function useAccount() {
  const { selected, codex, claude } = useConnect(useShallow((s) => ({ selected: s.selected, codex: s.codex, claude: s.claude })))
  const settings = useProject((s) => s.settings)
  const provider: Provider = chosenProvider(selected, settings) ?? chatProvider(resolveChatMode(null, settings))
  const stateOf = (p: Provider): ReturnType<typeof displayState> => displayState(p === 'codex' ? codex : claude, false)
  return { provider, stateOf }
}

/**
 * 제목줄 (DESIGN §1-3, 시안 ③④⑯).
 *
 * 왼쪽 서랍이 사라지면서 그 안에 있던 것들이 여기로 올라왔다: 논문 이름(논문 ▾),
 * AI 계정, 설정(⚙). 논문 차례·자료·만든 파일은 종이 머리로 갔다(PaperPane).
 * 가운데는 "지금" 하나 — 늘 보이는 진행 표시는 이 한 줄뿐이다(DESIGN §2).
 *
 * 좁은 창(⑯)과 "종이를 닫아 둔 넓은 창"은 같은 바꾸기를 쓴다: 한 칸 + [대화 | 내 논문].
 *
 * macOS 신호등 자리(왼쪽 여백)는 `main/index.ts`의 창 설정과 함께 봐야 해서 별도 작업
 * (feat/gui-v5-hidden) 합류 뒤에 맞춘다 — 그 전에는 CSS 토큰 `--titlebar-inset`만 비워 둔다.
 *
 * "지금 ▾"은 **3-A 합류 뒤**에 채운다(`stageSlot`) — 그 자리의 내용(지금 단계·사실 한 줄)은
 * `shared/stage.ts`의 순수 함수가 정하고 그 함수는 3-A 워커가 만든다. 그 전에는 자리를
 * 비워 둔다(발주 ③: 커밋에 가짜 규칙을 남기지 않는다).
 */
export function TitleBar({ stageSlot }: { stageSlot?: ReactNode }) {
  const { root, settings, open, setPaperClosed, paperClosed, paneView, setPaneView, openSheet, loadSettings } = useProject(useShallow((s) => ({
    root: s.root, settings: s.settings, open: s.open, setPaperClosed: s.setPaperClosed, paperClosed: s.paperClosed,
    paneView: s.paneView, setPaneView: s.setPaneView, openSheet: s.openSheet, loadSettings: s.loadSettings
  })))
  const select = useConnect((s) => s.select)
  const layout = useLayout()
  const { provider, stateOf } = useAccount()
  const [menu, setMenu] = useState<'paper' | 'account' | null>(null)

  const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
  const recent = (settings?.recent ?? []).filter((r) => r.root !== root).slice(0, 6)
  const state = stateOf(provider)
  /** 넓은데 닫아 둔 종이를 다시 여는 것도 학생의 선택이다 — 설정에 남긴다. */
  const showPaper = (): void => { setPaneView('paper'); if (paperClosed) setPaperClosed(false) }
  const pickProvider = async (p: Provider): Promise<void> => {
    await window.knuaf.setSettings({ helper_mode: p === 'claude' ? 'claude-chat' : 'codex-chat', provider_choice: { provider: p, at: new Date().toISOString() } })
    select(p)
    await loadSettings()
    setMenu(null)
  }

  return (
    <header className="titlebar">
      <div className="pop-host">
        <button className="tbtn title" title={TITLEBAR.paperMenuTitle} aria-expanded={menu === 'paper'}
          onClick={() => setMenu(menu === 'paper' ? null : 'paper')}>
          {root ? base(root) : TITLEBAR.paperNone}<Icon name="chevron" size={14} />
        </button>
        <Popover open={menu === 'paper'} onClose={() => setMenu(null)} label={TITLEBAR.paperMenuTitle} width={340}>
          <PopHead>{TITLEBAR.recentPapers}</PopHead>
          {recent.length === 0
            ? <div className="pop-empty caption">{TITLEBAR.noRecent}</div>
            : recent.map((r) => (
              /* 기록 번호는 붙이지 않는다(DESIGN §5) — 마지막으로 연 때만 말한다(설계자 답 Q1). */
              <PopRow key={r.root} icon={<Icon name="doc" size={16} />} meta={relativeTime(r.opened_at)}
                onClick={() => { setMenu(null); void open(r.root) }}>{base(r.root)}</PopRow>
            ))}
          <PopSep />
          <PopRow icon={<Icon name="folder" size={16} />} onClick={async () => {
            setMenu(null)
            const dir = await window.knuaf.pickFolder()
            if (dir) void open(dir)
          }}>{FOLDER.newAction}</PopRow>
          <PopRow icon={<Icon name="folder" size={16} />} onClick={async () => {
            setMenu(null)
            const dir = await window.knuaf.pickFolder()
            if (dir) void open(dir)
          }}>{TITLEBAR.openOther}</PopRow>
        </Popover>
      </div>

      {showsToggle(layout) && (
        <div className="tbar-seg" role="tablist" aria-label={TITLEBAR.segPaper}>
          <button type="button" role="tab" aria-selected={paneView === 'chat'} className={paneView === 'chat' ? 'on' : ''} onClick={() => setPaneView('chat')}>{TITLEBAR.segChat}</button>
          <button type="button" role="tab" aria-selected={paneView === 'paper'} className={paneView === 'paper' ? 'on' : ''} onClick={showPaper}>{TITLEBAR.segPaper}</button>
        </div>
      )}

      <span className="sp" />
      {stageSlot}
      <span className="sp" />

      {/* 첫 대화는 한 칸 — 옆 칸이 왜 비어 있는지 한 줄로 말한다(시안 ③). */}
      {layout.kind === 'solo' && <span className="tbtn quiet">{TITLEBAR.paperLater}</span>}

      <div className="pop-host">
        <button className="tbtn acct" title={TITLEBAR.accountTitle} aria-expanded={menu === 'account'}
          onClick={() => setMenu(menu === 'account' ? null : 'account')}>
          <span className={`dot${state === 'connected' ? '' : ' off'}`} />
          {state === 'connected' ? TITLEBAR.accountConnected(PROVIDER_NAME[provider]) : TITLEBAR.accountNone}
        </button>
        <Popover open={menu === 'account'} onClose={() => setMenu(null)} align="right" label={TITLEBAR.accountTitle} width={400}>
          <div className="list">
            {(['codex', 'claude'] as Provider[]).map((p) => (
              /* 첫 실행 1단계와 **같은 부품**이다 — 상태 문구도 행동 단추도 같다(설계자 답 Q2).
                 여기서만 "○○로 바꾸기"가 붙고, 그 선택은 설정 라디오와 같은 자격으로 기록된다.
                 "설정" 줄은 두지 않는다 — 바로 옆에 ⚙ 단추가 있어 같은 일을 두 번 두게 된다. */
              <ConnectRow key={p} provider={p} current={p === provider}
                extra={stateOf(p) === 'connected' && p !== provider
                  ? { label: TITLEBAR.switchTo(PROVIDER_NAME[p]), run: () => void pickProvider(p) }
                  : undefined} />
            ))}
          </div>
        </Popover>
      </div>

      <button className="tbtn icon" title={TITLEBAR.settingsTitle} onClick={() => openSheet('settings')}><Icon name="gear" size={17} /></button>
    </header>
  )
}
