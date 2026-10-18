import { useShallow } from 'zustand/react/shallow'
import { useProject } from '../store/project'
import { chosenProvider, displayState, useConnect } from '../store/connect'
import { chatProvider, resolveChatMode } from '../store/chat'
import { derive, nextAction, stageInputs, type StageAction, type StageDerived, type StageInputs } from '../../../shared/stage'

export interface Stage {
  inputs: StageInputs
  derived: StageDerived
  /** 종이 머리의 권하는 단추 하나 — 1·2단계는 null(대화와 첫 화면이 이끈다). */
  action: StageAction | null
}

/**
 * "지금" 하나 (IMPL-PLAN §4-4) — 판정은 3-A 의 순수 함수(`derive`·`nextAction`)가 하고,
 * 여기서는 **사이드카 사실 + 렌더러가 아는 것**을 그 입력으로 모으기만 한다.
 *
 * 렌더러가 아는 넷(REPORT-P3A §0 "3-B 가 밖에서 채워야 하는 것"):
 * `root`·`connected`(고른 공급자가 연결됐을 때만 true)·`depsFailed`(준비 실패)·
 * `hasProject`. 나머지는 `stageInputs` 가 사이드카 응답에서 옮긴다.
 */
export function useStage(): Stage {
  const { root, hasProject, status, depsReady, error, sections, artifacts, buildTree, projectLoad } = useProject(useShallow((s) => ({
    root: s.root, hasProject: s.hasProject, status: s.status, depsReady: s.depsReady, error: s.error,
    sections: s.sections, artifacts: s.artifacts, buildTree: s.buildTree, projectLoad: s.projectLoad
  })))
  const { selected, codex, claude } = useConnect(useShallow((s) => ({ selected: s.selected, codex: s.codex, claude: s.claude })))
  const settings = useProject((s) => s.settings)

  const provider = chosenProvider(selected, settings) ?? chatProvider(resolveChatMode(null, settings))
  const info = provider === 'codex' ? codex : claude
  const connState = displayState(info, false)
  const facts = stageInputs(status, sections ?? [], buildTree, artifacts ? { items: artifacts } : null, projectLoad)
  const inputs: StageInputs = {
    ...facts,
    root: !!root,
    // 확인하지 못한 것(`unknown`·`failed`)을 연결됨으로 꾸미지 않는다.
    connected: connState === 'connected',
    depsFailed: error?.code === 'deps_ensure' || depsReady === false,
    hasProject
  }
  const derived = derive(inputs)
  return { inputs, derived, action: nextAction(inputs, derived) }
}
