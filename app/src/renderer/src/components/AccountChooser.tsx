import { ConnectRow } from './ConnectRow'
import { useProject } from '../store/project'
import { chosenProvider, displayState, useConnect } from '../store/connect'
import { chatProvider, resolveChatMode } from '../store/chat'
import { PROVIDER_NAME, TITLEBAR } from '../copy'
import type { Provider } from '../../../shared/chat'
import { useShallow } from 'zustand/react/shallow'

/**
 * 지금 대화하는 공급자 하나 — 제목줄 계정 자리와 입력칸의 모델 칩이 같은 것을 본다.
 * 우선순위: 학생이 고른 것 → 옛 설정(`helper_mode`). 판정은 `chosenProvider` 한 곳에 있다.
 */
export function useAccountProvider(): { provider: Provider; stateOf: (p: Provider) => ReturnType<typeof displayState> } {
  const { selected, codex, claude } = useConnect(useShallow((s) => ({ selected: s.selected, codex: s.codex, claude: s.claude })))
  const settings = useProject((s) => s.settings)
  const provider: Provider = chosenProvider(selected, settings) ?? chatProvider(resolveChatMode(null, settings))
  const stateOf = (p: Provider): ReturnType<typeof displayState> => displayState(p === 'codex' ? codex : claude, false)
  return { provider, stateOf }
}

/**
 * AI 바꾸기 목록 — 제목줄 계정 팝오버와 입력칸 `+` 옆 모델 칩이 **같은 것**을 연다(발주 I-02).
 * 두 벌로 두면 한쪽만 고쳐지고, 같은 사실(연결 상태)이 두 모양으로 보인다. 첫 실행 1단계와
 * 같은 부품(`ConnectRow`)을 쓰고, 여기서만 "○○로 바꾸기"가 붙는다.
 *
 * 상태 갱신·로그인 폴링은 `store/connect` 그대로다 — 여기서 새 규칙을 만들지 않는다.
 * `onPicked` 는 공급자를 바꾼 뒤 부르는 몫(팝오버를 닫는 일)이다.
 */
export function AccountChooser({ onPicked }: { onPicked?: () => void }) {
  const { provider, stateOf } = useAccountProvider()
  const select = useConnect((s) => s.select)
  const loadSettings = useProject((s) => s.loadSettings)
  const pickProvider = async (p: Provider): Promise<void> => {
    await window.knuaf.setSettings({ helper_mode: p === 'claude' ? 'claude-chat' : 'codex-chat', provider_choice: { provider: p, at: new Date().toISOString() } })
    select(p)
    await loadSettings()
    onPicked?.()
  }
  return (
    <div className="list">
      {(['codex', 'claude'] as Provider[]).map((p) => (
        <ConnectRow key={p} provider={p} current={p === provider}
          extra={stateOf(p) === 'connected' && p !== provider
            ? { label: TITLEBAR.switchTo(PROVIDER_NAME[p]), run: () => void pickProvider(p) }
            : undefined} />
      ))}
    </div>
  )
}
