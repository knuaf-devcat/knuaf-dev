/**
 * 진행 규칙 — "지금"은 하나, 권하는 단추도 하나.
 *
 * 다섯 단계의 상태와 "지금"은 사이드카가 알려주는 사실에서만 나온다. 화면 조각마다
 * 조건을 흩어 놓으면 "질문이 남아 있는데 파일부터 만들라고 한다" 같은 어긋남이 생긴다.
 * 그래서 판정은 여기 순수 함수 하나(`derive`)가 하고, 사이드카가 돌려준 모양을 그
 * 입력으로 바르게 옮기는 일은 `stageInputs` 가 한다.
 *   - 검토본 기준 N 은 `fs.build_tree` 의 `build/<N>/review/` 에서 읽는다(검토 IMPL-R1-03).
 *     `artifact.list` 의 `revision` 은 쓰지 않는다.
 *   - 파일 현재성은 `project.load` 의 `outputs[*].stale` 뿐이다. 기록 번호 비교는 금지다(v2 §4-1).
 *
 * 렌더러·main 어디에도 의존하지 않는다 — 화면(3-B)과 Node 단위 시험이 같은 함수를 쓴다.
 */
import type { SectionRow, Status } from './types'
import { waitingQuestionCount } from './zone'

export type StageNo = 1 | 2 | 3 | 4 | 5

/** 절 하나 — 차례와 장 상태 말에 쓰는 만큼만. 순서는 `project.sections` 가 준 순서 그대로다. */
export interface StageSection {
  id: string
  title: string
  /** `empty` | `drafting` | `review_ready` (그 밖의 값도 그대로 흘려보낸다). */
  status: string
}

/** 사이드카가 돌려준 값에서 만드는 입력 — `stageInputs` 의 출력이다. */
export interface StageFacts {
  /** 도우미가 기다리는 질문 수(한글 마무리는 뺀다). */
  questions: number
  sections: StageSection[]
  /** 등록 산출물 중 하나라도 `stale` 인가. */
  stale: boolean
  /** 검토본이 있는 가장 큰 개정 N. 없으면 null. */
  reviewExport: number | null
  hasDocx: boolean
}

/** 판정 입력 — 사이드카 사실 + 렌더러가 아는 것. */
export interface StageInputs extends StageFacts {
  /** 폴더를 열었나. */
  root: boolean
  /** 고른 공급자가 연결됐나(`unknown`·`failed` 는 false). */
  connected: boolean
  /** 도구 준비 실패(`deps_ensure`·`depsReady === false`). */
  depsFailed: boolean
  /** 정본이 있나(`useProject.hasProject`). */
  hasProject: boolean
}

/** `derive` 의 결과 — "지금" 하나와 단계별 사실. */
export interface StageDerived {
  now: StageNo
  sections: StageSection[]
  /** 초안을 다 쓴 장 수. */
  sectionsDone: number
  /** 등록된 장이 있고 전부 `review_ready`. */
  sectionsAllReady: boolean
  /** 쓰는 중인 첫 장의 자리. 없으면 -1. */
  writingIndex: number
  stale: boolean
  reviewExport: number | null
  hasReview: boolean
  hasDocx: boolean
  questions: number
}

/** 종이 머리의 권하는 단추 하나(2단계·1단계는 null — 대화와 첫 화면이 이끈다). */
export interface StageAction {
  stage: StageNo
  label: string
  hint: string
}

/** `fs.build_tree` 가 돌려주는 모양에서 읽는 것만. */
export interface StageBuildTree {
  revisions?: { revision?: number; kinds?: { kind?: string }[] }[]
}

/** `artifact.list`. */
export interface StageArtifacts {
  items?: { kind?: string }[]
}

/** `project.load`. 파일 현재성은 여기 `outputs[*].stale` 로만 읽는다. */
export interface StageLoad {
  project?: { outputs?: Record<string, { stale?: boolean } | null> | null } | null
}

function reviewExportOf(tree: StageBuildTree | null): number | null {
  let best: number | null = null
  for (const rev of tree?.revisions ?? []) {
    if (typeof rev?.revision !== 'number') continue
    if (!(rev.kinds ?? []).some((k) => k?.kind === 'review')) continue
    if (best === null || rev.revision > best) best = rev.revision
  }
  return best
}

function staleOf(load: StageLoad | null): boolean {
  return Object.values(load?.project?.outputs ?? {}).some((out) => out?.stale === true)
}

/** 사이드카가 실제로 돌려주는 모양 → 진행 규칙의 입력. 절 순서는 준 순서를 지킨다. */
export function stageInputs(
  projectStatus: Status | null,
  sections: SectionRow[],
  buildTree: StageBuildTree | null,
  artifacts: StageArtifacts | null,
  load: StageLoad | null
): StageFacts {
  return {
    questions: waitingQuestionCount(projectStatus),
    sections: sections.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    stale: staleOf(load),
    reviewExport: reviewExportOf(buildTree),
    hasDocx: (artifacts?.items ?? []).some((item) => item?.kind === 'docx')
  }
}

/** v2 §4-3 우선순위 — 위에서부터 처음 맞는 것 하나가 "지금"이다. */
export function derive(inputs: StageInputs): StageDerived {
  const sectionsAllReady =
    inputs.sections.length > 0 && inputs.sections.every((s) => s.status === 'review_ready')
  let now: StageNo
  if (!inputs.root || !inputs.connected || inputs.depsFailed) now = 1
  else if (!inputs.hasProject || inputs.questions > 0 || !sectionsAllReady) now = 2
  else if (inputs.stale) now = 4
  else if (inputs.reviewExport === null) now = 3
  else if (!inputs.hasDocx) now = 4
  else now = 5
  return {
    now,
    sections: inputs.sections,
    sectionsDone: inputs.sections.filter((s) => s.status === 'review_ready').length,
    sectionsAllReady,
    writingIndex: inputs.sections.findIndex((s) => s.status === 'drafting'),
    stale: inputs.stale,
    reviewExport: inputs.reviewExport,
    hasReview: inputs.reviewExport !== null,
    hasDocx: inputs.hasDocx,
    questions: inputs.questions
  }
}

/** 단계별 단추 이름은 v5 DESIGN §2 표 그대로다. 1·2단계는 단추가 없다. */
export function nextAction(_inputs: StageInputs, derived: StageDerived): StageAction | null {
  if (derived.now === 3) return { stage: 3, label: '검토본 만들기', hint: '다 쓴 장을 묶어 읽어 봐요' }
  if (derived.now === 4) {
    return derived.stale
      ? { stage: 4, label: '논문 파일 다시 만들기', hint: '고친 내용이 파일에 아직 없어요' }
      : { stage: 4, label: '논문 파일 만들기', hint: '워드 파일로 받아요' }
  }
  if (derived.now === 5) return { stage: 5, label: '제출 전 점검', hint: '내가 직접 할 것을 한 장에서 봐요' }
  return null
}
