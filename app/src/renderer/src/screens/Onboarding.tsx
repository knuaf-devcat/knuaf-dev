import { useProject } from '../store/project'
import { useChat } from '../store/chat'
import { FirstRun } from '../components/FirstRun'

/**
 * 첫 실행 화면 — 크롬 없이 가운데 한 줄기(발주 QA 재실행 결정).
 *
 * 내용(두 단계·길잡이)은 `FirstRun` 한 곳에 있고, 여기서는 그 부품을 크롬 없는 틀에 얹고
 * "폴더를 골랐다"는 사실을 기록한다. 재실행 첫 화면도 **같은 부품**을 제목줄 있는 대화 칸
 * 안에 얹는다(`Chat` 의 폴더 없음 화면) — 재실행에서는 시작 의사를 남기지 않는다.
 */
export function Onboarding({ onDone }: { onDone?: () => void }) {
  const loadSettings = useProject((s) => s.loadSettings)
  /**
   * 폴더가 열렸다 — 첫 실행 화면을 지났음을 기록하고, 그 폴더에서 첫 대화를 시작할 의사를
   * 남긴다(대화가 비어 있으면 Chat 이 한 번 보낸다). 여기서 보내지 않는 이유: 대화 화면이
   * 뜨기도 전에 보내면 그 응답을 받을 화면이 없다.
   */
  const opened = async (root: string): Promise<void> => {
    await window.knuaf.setSettings({ onboarded_at: new Date().toISOString() })
    useChat.getState().armStart(root)
    await loadSettings()
    onDone?.()
  }
  return (
    <div className="onb">
      <div className="drag-strip" aria-hidden="true" />
      <div className="onb-inner">
        <FirstRun onFolderOpened={(root) => void opened(root)} />
      </div>
    </div>
  )
}
