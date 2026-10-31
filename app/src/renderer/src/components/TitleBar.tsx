import { useState } from 'react'
import { Icon } from './Icon'
import { PopHead, Popover, PopRow, PopSep } from './Popover'
import { StageMenu } from './StageMenu'
import { useProject } from '../store/project'
import { FOLDER, TITLEBAR, relativeTime } from '../copy'
import { showsToggle, useLayout } from './useLayout'
import { useShallow } from 'zustand/react/shallow'
import { AppUpdateDialog, useUpdateSubscription, useUpdates } from './Updates'
import { UPDATE } from '../copy'

/**
 * 제목줄 (DESIGN §1-3, 시안 ③④⑯).
 *
 * 논문 이름과 진행 단계, 설정을 보여 준다. AI 연결과 전환은 대화 입력칸의 모델 칩에서 한다.
 *
 * 좁은 창(⑯)과 "종이를 닫아 둔 넓은 창"은 같은 바꾸기를 쓴다: 한 칸 + [대화 | 내 논문].
 *
 * macOS 신호등 자리(왼쪽 여백)는 `main/index.ts`의 창 설정과 함께 봐야 해서 별도 작업
 * (feat/gui-v5-hidden) 합류 뒤에 맞춘다 — 그 전에는 CSS 토큰 `--titlebar-inset`만 비워 둔다.
 *
 * 가운데 "지금 · ○○ ▾"은 `StageMenu` 다 — 3-A 의 `derive()` 가 정한 "지금" 하나를 말한다.
 */
export function TitleBar() {
  useUpdateSubscription()
  const skillUpdate = useUpdates(s => s.skill)
  const appUpdate = useUpdates(s => s.app)
  const showUpdate = useUpdates(s => s.setDialog)
  const blocked = appUpdate?.phase === 'blocked'
  const appAvailable = blocked || !!appUpdate?.latest && ['available', 'interrupted', 'error', 'downloading', 'preparing', 'launching'].includes(appUpdate.phase)
  const hasUpdate = skillUpdate?.phase === 'available' || appAvailable
  const { root, settings, open, setPaperClosed, paperClosed, paneView, setPaneView, openSheet } = useProject(useShallow((s) => ({
    root: s.root, settings: s.settings, open: s.open, setPaperClosed: s.setPaperClosed, paperClosed: s.paperClosed,
    paneView: s.paneView, setPaneView: s.setPaneView, openSheet: s.openSheet
  })))
  const layout = useLayout()
  const [menu, setMenu] = useState<'paper' | null>(null)

  const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
  const recent = (settings?.recent ?? []).filter((r) => r.root !== root).slice(0, 6)
  /** 넓은데 닫아 둔 종이를 다시 여는 것도 학생의 선택이다 — 설정에 남긴다. */
  const showPaper = (): void => { setPaneView('paper'); if (paperClosed) setPaperClosed(false) }

  return (
    <header className="titlebar">
      <div className="pop-host">
        <button className="tbtn title" title={TITLEBAR.paperMenuTitle} aria-expanded={menu === 'paper'}
          onClick={() => setMenu(menu === 'paper' ? null : 'paper')}>
          {root ? base(root) : TITLEBAR.paperNone}<Icon name="chevronDown" size={14} />
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
      <StageMenu />
      <span className="sp" />

      {/* 첫 대화는 한 칸 — 옆 칸이 왜 비어 있는지 한 줄로 말한다(시안 ③). */}
      {layout.kind === 'solo' && <span className="tbtn quiet">{TITLEBAR.paperLater}</span>}


      <button className="tbtn icon" style={{ position: 'relative' }} title={TITLEBAR.settingsTitle} aria-label={hasUpdate ? `${TITLEBAR.settingsTitle} · ${blocked ? UPDATE.appBlockedTitle : UPDATE.newAvailable}` : TITLEBAR.settingsTitle} onClick={() => openSheet('settings')}>
        <Icon name="gear" size={17} />
        {hasUpdate && <span aria-hidden="true" style={{ position: 'absolute', right: 3, top: 3, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />}
      </button>
      {appAvailable && <button className="tbtn" style={{ borderRadius: 5, background: 'var(--btn-bg)', color: 'var(--btn-ink)', border: '1px solid var(--btn-border)' }} onClick={() => showUpdate(true)}>{blocked ? UPDATE.appBlockedTitle : UPDATE.title}</button>}
      <AppUpdateDialog />
    </header>
  )
}
