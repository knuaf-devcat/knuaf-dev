import { useEffect, useState } from 'react'
import { useProject } from '../store/project'
import { Feedback } from './Feedback'
import { RuntimeFix } from './RuntimeFix'
import { ProjectCard } from './ProjectCard'
import { EMPTY, relativeTime, type DescribedError } from '../copy'
import type { ProjectPeek, RecentEntry } from '../../../shared/types'
import { useShallow } from 'zustand/react/shallow'

/**
 * 폴더 고르기 — 첫 실행 2단계와 재방문(폴더 없음) 화면이 **같은 것을 쓴다**.
 *
 * 두 벌로 두면 한쪽만 고쳐지고, 학생에게는 같은 일을 하는 화면이 두 모양으로 보인다
 * (발주 ③ "NoFolder 는 2단계로 흡수"). 다른 것은 제목·부제뿐이라 그것만 밖에서 받는다.
 *
 * 문구는 여기에 두지 않는다 — `screens/`·`components/` 밖(copy.ts)에 모아야 하는 규칙이
 * e2e/invariants.spec.ts 에 있다. 그래서 글자는 전부 호출자가 넘긴다.
 */
export interface FolderPickerCopy {
  title: string
  intro: string
  newName: string
  newBody: string
  newAction: string
  recentName: string
  recentBody: string
  recentAction: string
  recents: string
  /** 맨 아래 한 줄 — 끌어다 놓기 안내 같은 것. */
  foot?: string
}

export function FolderPicker({ copy, onOpened }: { copy: FolderPickerCopy; onOpened?: (root: string) => void }) {
  const { open, settings, error, loading, loadSettings, clearError, openFailure } = useProject(useShallow((s) => ({
    open: s.open, settings: s.settings, error: s.error, loading: s.loading, loadSettings: s.loadSettings, clearError: s.clearError, openFailure: s.openFailure
  })))
  const [peeks, setPeeks] = useState<Record<string, ProjectPeek>>({})
  const [openErr, setOpenErr] = useState<DescribedError | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Record<string, ProjectPeek> = {}
      for (const r of settings?.recent ?? []) out[r.root] = await window.knuaf.peekProject(r.root)
      if (alive) setPeeks(out)
    })()
    return () => { alive = false }
  }, [settings?.recent])

  /** 실패는 이 화면에서 한 번만 알린다 — 전역 error 에 두면 다른 화면에도 같은 오류가 뜬다(GUI-04). */
  const openFolder = async (dir: string): Promise<DescribedError | null> => {
    setOpenErr(null); clearError()
    const err = await open(dir, { local: true })
    if (err) { setOpenErr(err); return err }
    onOpened?.(dir)
    return null
  }
  const pick = async () => { const dir = await window.knuaf.pickFolder(); if (dir) await openFolder(dir) }
  const remove = async (root: string) => {
    await window.knuaf.setSettings({ recent: (settings?.recent ?? []).filter((x) => x.root !== root) })
    await loadSettings()
  }

  // 시작 실패(openFailure)는 FirstRun 이 화면 위에서 한 번만 보여 준다 — 여기서 또 그리면
  // 같은 오류 카드가 두 장이 된다. 그 밖의 전역 오류는 지금처럼 이 화면이 맡는다.
  const shown = openErr ?? (openFailure ? null : error)
  return (
    <>
      <h1>{copy.title}</h1>
      <p className="caption" style={{ margin: 'var(--sp-2) 0 var(--sp-5)' }}>{copy.intro}</p>

      {shown && <Feedback kind={shown.kind} title={shown.title} body={shown.action} details={<code>{shown.raw}</code>} />}
      {/* 실패한 그 요청의 인터프리터 정보로만 버튼을 세운다 — store.sidecar(성공한 프로젝트)로
          판단하면 첫 실패에서 버튼이 없고, 다른 논문을 열었던 세션에서는 틀린 kind 가 된다.
          재시도는 같은 openFolder 를 타므로 성공 후처리(onOpened)까지 그대로 이어진다. */}
      {shown && openFailure && shown.code === openFailure.code && (
        <RuntimeFix failure={openFailure} onRetry={async () => (await openFolder(openFailure.root)) === null} />
      )}

      {/* 새로 시작 / 이어 쓰기 두 행 — 첫 실행 연결 단계와 같은 한 테두리 묶음(시안 B, N-R01). */}
      <div className="choices">
        <div className="item"><div className="head">
          <div>
            <div style={{ fontWeight: 600 }}>{copy.newName}</div>
            <div className="reason caption">{copy.newBody}</div>
          </div>
          <button className="primary" onClick={() => void pick()} disabled={loading}>{copy.newAction}</button>
        </div></div>
        <div className="item"><div className="head">
          <div>
            <div style={{ fontWeight: 600 }}>{copy.recentName}</div>
            <div className="reason caption">{copy.recentBody}</div>
          </div>
          <button onClick={() => void pick()} disabled={loading}>{copy.recentAction}</button>
        </div></div>
      </div>

      <h2 style={{ marginTop: 'var(--sp-6)', fontSize: 'var(--fs-caption)' }}>{copy.recents}</h2>
      {(settings?.recent ?? []).length === 0
        ? <p className="caption">{EMPTY.recent.title}</p>
        : <div className="projects stagger">
          {(settings?.recent ?? []).map((r: RecentEntry, i) => {
            const p = peeks[r.root]
            return (
              <ProjectCard key={r.root} index={i} root={r.root} openedAt={relativeTime(r.opened_at)}
                exists={p ? p.exists : true} hasProject={p?.hasProject ?? false}
                onOpen={() => void openFolder(r.root)} onRemove={() => void remove(r.root)} />
            )
          })}
        </div>}

      {copy.foot && <p className="caption" style={{ marginTop: 'var(--sp-6)' }}>{copy.foot}</p>}
    </>
  )
}
