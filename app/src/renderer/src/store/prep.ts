import { create } from 'zustand'

/**
 * 폴더 준비(`deps.ensure`) 중인가 — 대화 전송과 화면이 함께 본다.
 *
 * 왜 따로 두나(형님 윈도우 실기 2026-10-19): 새 폴더를 열면 앱이 그 폴더의 `.venv` 를 뒤에서
 * 조용히 준비한다(`store/project.ts` `prepareDeps`). 윈도우에서는 몇 분 걸린다. 그 사이 학생이
 * "새로 시작하기"를 누르면 main 이 쓰기 작업 중이라 전송을 거절했고("앱이 저장·검사 작업 중이에요"),
 * 그 빨간 알림은 준비가 끝나도 남아 얼마나 기다려야 할지 알 수 없었다. 이제 전송은 준비가
 * 끝날 때까지 **기다렸다가** 보내고(`store/chat.ts` `send`), 그동안 화면은 진행 표시를 띄운다.
 *
 * project·chat 두 저장소가 서로를 부르지 않게 이 작은 저장소 하나를 둘이 같이 쓴다.
 */
interface PrepState {
  /** 지금 준비 중인 폴더. 없으면 null. */
  root: string | null
  begin: (root: string) => void
  end: (root: string) => void
}

export const usePrep = create<PrepState>((set, get) => ({
  root: null,
  begin: (root) => set({ root }),
  end: (root) => { if (get().root === root) set({ root: null }) }
}))

/** `root` 의 준비가 끝날 때까지 기다린다 — 준비 중이 아니면 바로 돌아온다. */
export function whenPrepared(root: string): Promise<void> {
  if (usePrep.getState().root !== root) return Promise.resolve()
  return new Promise((done) => {
    const off = usePrep.subscribe((s) => { if (s.root !== root) { off(); done() } })
  })
}
