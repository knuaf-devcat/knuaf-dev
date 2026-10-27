import { create } from 'zustand'
import { usePrep } from './prep'
import type { ArtifactItem, MaterialsData, ProjectPeek, SectionRow, Settings, SidecarInfo, Status } from '../../../shared/types'
import type { StageBuildTree } from '../../../shared/stage'
import type { ProjectLoad } from '../rpc'
import { CHAT, HELPER, describeError, type DescribedError } from '../copy'
import { rpc } from '../rpc'
import { chatProvider, resolveChatMode, useChat } from './chat'
import { chosenProvider, useConnect } from './connect'
import type { Provider } from '../../../shared/chat'

/**
 * 지금 대화할 공급자 — **화면(`Chat`)이 계산하는 것과 같은 규칙**을 쓴다(store/connect 의
 * `chosenProvider` → 옛 설정 `helper_mode`).
 *
 * 왜 여기서 필요한가: 폴더를 열 때 이 store 가 `load(root)` 를 먼저 부르는데, 공급자를 넘기지
 * 않으면 스토어 기본값('codex')으로 읽고 화면이 곧바로 **다른 공급자로 한 번 더 읽어** 대화를
 * 비운다(맥 CI 에서 드러난 재마운트의 한 원인). 같은 값을 넘겨 그 두 번째 읽기를 없앤다.
 */
function chatProviderNow(): Provider {
  const settings = useProject.getState().settings
  return chosenProvider(useConnect.getState().selected, settings) ?? chatProvider(resolveChatMode(null, settings))
}

/**
 * v5에서는 **화면**이 아니라 **열린 시트**다(IMPL-PLAN §4-5). 사이드바 목적지 다섯이
 * 사라지고, 자료·결과물·점검·설정은 논문 위에 덮이는 한 장이 됐다. 대화는 언제나 깔려
 * 있으므로 "대화로 돌아가기"는 시트를 닫는 일(`closeSheet`)이다.
 */
export type Screen = 'materials' | 'artifacts' | 'checkup' | 'settings'

/**
 * 설정 화면 안에서 펼침을 열 대상 — 'tools:excel' 같은 프리셋. 실패 피드백의
 * "고급 도구에서 직접 실행"이 여기로 간다(Q2: "설정으로 가세요"가 아니라 해당 항목 직결).
 */
export type SettingsFocus = string | null

interface ProjectState {
  root: string | null
  hasProject: boolean
  status: Status | null
  peek: ProjectPeek | null
  depsReady: boolean | null
  loading: boolean
  error: DescribedError | null
  /**
   * 시작 단계에서 실패한 **그 요청**의 정보(PY-D1-03). 준비 버튼의 조건과 재시도 대상 root 는
   * 오직 여기서 온다 — `sidecar` 는 성공한 프로젝트의 값이라 첫 실패·이전 프로젝트에서 틀린다.
   * 오류 카드를 닫으면(`clearError`) 같이 지운다.
   */
  openFailure: { root: string; sidecar: SidecarInfo; code: string } | null
  /**
   * 앱 전용 Python 설치 뒤 **재시도가 또 실패**했음(§7). 설치 성공을 폴더 복구 성공으로
   * 표시하지 않기 위해 결과를 컴포넌트가 아니라 store 가 보관한다 — 재시도는 `open()` 이
   * `openFailure` 를 지우며 진행되므로, 지역 상태에 두면 화면이 사라지고 결과도 사라진다.
   */
  retryFailed: { root: string } | null
  /**
   * 실패했던 폴더 열기를 다시 시도하고, 그 결과를 store 에 남긴다(설치 성공과 구분).
   * `onOpened` 는 성공했을 때만 부르고, **끝날 때까지 기다린다** — 재시도의 성공은 온보딩 기록
   * (`setSettings`)까지 끝난 뒤에 확정된다. 기다리지 않으면 화면 전환과 기록 사이에 순서가
   * 없어져, 느린 기기에서 "열렸다"는 사실만 먼저 보인다.
   */
  retryOpen: (root: string, onOpened?: (root: string) => void | Promise<void>) => Promise<boolean>
  sidecar: (SidecarInfo & { basePython?: string; wheelhouse?: string | null }) | null
  settings: Settings | null
  /** 열려 있는 시트. null이면 논문·대화만 보인다. */
  sheet: Screen | null
  settingsFocus: SettingsFocus
  logs: { stream: string; line: string }[]
  openSheet: (s: Screen) => void
  /** 시트를 닫는다 — v5의 "대화로 돌아가기"(자료의 "답변에 첨부", 점검의 "고쳐달라기" 등). */
  closeSheet: () => void
  /** Navigate to 설정 with a disclosure preset open (deep link from failure feedback). */
  openSettings: (focus?: SettingsFocus) => void
  clearSettingsFocus: () => void
  loadSettings: () => Promise<void>
  /**
   * 등록된 절 목록. 종이 칸이 이 순서대로 본문을 그리고, "본문이 있는 장이 있는가"도
   * 여기서 나온다(IMPL-PLAN §4-2). 정본 감시가 기록이 오르면 다시 읽는다.
   */
  sections: SectionRow[] | null
  loadSections: () => Promise<void>
  /**
   * 자료·결과물 목록. 종이 머리의 "자료 N · 파일 N"과 팝오버, 그리고 시트가 **같은 것**을
   * 본다 — 화면마다 따로 읽으면 한 곳만 갱신되고 숫자가 어긋난다.
   */
  materials: MaterialsData | null
  artifacts: ArtifactItem[] | null
  /** `build/` 개정 트리 — 검토본 기준 N(진행 규칙 §4-4)을 여기서 읽는다. */
  buildTree: StageBuildTree | null
  /** 정본 전체(`project.load`) — 파일 현재성은 여기 `outputs[*].stale` 뿐이다(v2 §4-1). */
  projectLoad: ProjectLoad | null
  loadLists: () => Promise<void>
  /**
   * 새로고침 횟수. 읽기(정본·자료·결과물)는 기록이 오르면 다시 하지만, **파일이 새로 생긴 것**
   * (예: 표지 입력 `paper-input.json`)은 기록을 바꾸지 않는다 — 만들기 조건이 그것을 보려면
   * 새로고침도 세어야 한다(검토 P3-R1-05).
   */
  refreshSeq: number
  /** 창 **내부** 폭 — 배치 판정(`layoutOf`)의 입력. ResizeObserver가 채운다. */
  windowWidth: number
  setWindowWidth: (w: number) => void
  /**
   * 학생이 종이 칸을 닫았는지. 배치 중 **유일하게 저장하는 값**이다(IMPL-PLAN §4-2) —
   * 닫으면 다시 저절로 열리지 않고, 앱을 다시 켜도 닫힌 채다.
   */
  paperClosed: boolean
  setPaperClosed: (closed: boolean) => void
  /**
   * 좁은 창(`switch`)에서 지금 보고 있는 칸. 배치가 두 칸이면 쓰지 않는다.
   * 저장하지 않는다 — 창을 넓히면 두 칸이 다 보이므로 기억할 것이 없다.
   */
  paneView: 'chat' | 'paper'
  setPaneView: (v: 'chat' | 'paper') => void
  /**
   * 도우미가 절을 쓴 사실 — 앱이 그리는 **대화 이벤트 줄**이다(IMPL-PLAN §3).
   * 대화 기록 파일(`chat-<provider>.json`)에는 쓰지 않는다. 절 제목은 `section.read`가 아니라
   * `project.sections`에서 가져온다(도우미 글의 머리 배너를 되뇌지 않기 위함).
   */
  events: { id: string; sectionId: string; title: string; at: string }[]
  /** 종이에서 어느 장으로 갈지 — 대화 이벤트 줄의 "종이에서 보기"가 세운다. */
  focusedSection: string | null
  focusSection: (id: string | null) => void
  /**
   * `local: true` — 실패를 전역 error 대신 반환값으로 돌려준다. 경로를 입력한 화면이
   * 제자리에서 알리게 하기 위함(GUI-04): 전역 error 는 Chat/Checkup 도 그리므로
   * 둘 다 세면 같은 오류가 두 화면에 뜬다.
   */
  open: (root: string, opts?: { local?: boolean }) => Promise<DescribedError | null>
  /** `quiet: true` — 감시 타이머가 스스로 부르는 갱신. 스피너를 켜지 않고 한 번의 실패로 화면을 덮지 않는다. */
  refresh: (opts?: { quiet?: boolean }) => Promise<void>
  /** 정본이 생겼는지, 그리고 읽어 둔 것보다 기록이 올랐는지 — project.json 만 읽는다. */
  watchCanon: () => Promise<void>
  refreshSidecar: () => Promise<void>
  refreshDeps: () => Promise<void>
  prepareDeps: (root: string) => Promise<void>
  clearError: () => void
  helper: { open: boolean; status: any | null; result: { title: string; body?: string; kind: 'claude' | 'codex' } | null; error: DescribedError | null }
  openHelper: () => Promise<void>
  launchHelper: (kind: 'claude' | 'codex') => Promise<void>
  closeHelper: () => void
  pushLog: (entry: { stream: string; line: string }) => void
  clearLogs: () => void
}

/**
 * 폴더가 열려 있는 동안 도는 정본 감시 타이머. project.json 만 읽고 사이드카는
 * 띄우지 않는다.
 *
 * 정본이 "생겼는지"만 보던 때에는 점검 화면이 폴더를 연 순간의 상태를 그대로 붙들고
 * 있었다. 도우미가 스무 번을 저장해도 "고칠 곳 0"이 남아, 자동 점검 실패 60건짜리
 * 원고를 학생이 다 된 것으로 읽었다. 그래서 기록이 오른 것도 같이 본다.
 * (loginPoll 이 정리되지 않는 문제가 있었으니 폴더를 바꿀 때 반드시 끈다.)
 */
let canonPoll: ReturnType<typeof setInterval> | null = null
function stopCanonPoll(): void { if (canonPoll) { clearInterval(canonPoll); canonPoll = null } }
/**
 * 절마다 직전에 본 본문 지문(`draft_hash`). **메모리에만** 둔다 — 저장하지 않는다.
 * 이 값이 달라진 절이 "도우미가 방금 쓴 장"이다(대화 이벤트 줄). 폴더를 열면 비우므로
 * 앱을 켠 직후 첫 읽기에서는 아무 일도 알리지 않는다.
 */
let sectionHashes: Record<string, string> | null = null
/** 읽는 중에 또 읽지 않는다 — 감시 타이머가 사이드카를 겹쳐 띄우지 않게. */
let statusInFlight = false
/** 조용한 갱신이 잇따라 실패하면 그때는 말한다 — 한 번은 도우미가 쓰는 중일 수 있다. */
let quietFailures = 0

export const useProject = create<ProjectState>((set, get) => ({
  root: null,
  hasProject: false,
  status: null,
  peek: null,
  depsReady: null,
  loading: false,
  error: null,
  openFailure: null,
  retryFailed: null,
  sidecar: null,
  settings: null,
  sheet: null,
  settingsFocus: null,
  logs: [],
  sections: null,
  materials: null,
  artifacts: null,
  buildTree: null,
  projectLoad: null,
  refreshSeq: 0,
  windowWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
  paperClosed: false,
  paneView: 'chat',
  events: [],
  focusedSection: null,
  openSheet: (sheet) => { set({ sheet, ...(sheet === 'settings' ? {} : { settingsFocus: null }) }); location.hash = sheet },
  closeSheet: () => { set({ sheet: null, settingsFocus: null }); location.hash = '' },
  openSettings: (focus = null) => { set({ sheet: 'settings', settingsFocus: focus }); location.hash = 'settings' },
  clearSettingsFocus: () => set({ settingsFocus: null }),
  loadSettings: async () => {
    const settings = await window.knuaf.getSettings()
    const root = get().root
    // 종이 닫힘도 설정에서 읽는다 — 앱을 다시 켜도 학생이 닫아 둔 것은 닫힌 채다.
    set({ settings, ...(root ? { paperClosed: settings?.ui_prefs?.[root]?.paperClosed === true } : {}) })
  },
  loadSections: async () => {
    const root = get().root
    if (!root) { set({ sections: null }); return }
    try {
      const rows = await rpc.sections(root)
      if (get().root !== root) return
      set({ sections: rows })
      const prev = sectionHashes
      sectionHashes = Object.fromEntries(rows.map((r) => [r.id, r.draft_hash]))
      // 폴더를 연 뒤 첫 판정에서는 알리지 않는다 — 그때는 모든 절이 "처음 보는" 것이다.
      if (!prev) return
      const wrote = rows.filter((r) => prev[r.id] !== undefined && prev[r.id] !== r.draft_hash)
      if (wrote.length) set((s) => ({ events: [...s.events, ...wrote.map((r) => ({ id: `${r.id}:${r.draft_hash}`, sectionId: r.id, title: r.title, at: new Date().toISOString() }))].slice(-20) }))
    } catch {
      // 읽지 못한 것을 "등록된 절이 없다"로 꾸미지 않는다 — null 은 모른다는 뜻이다.
      if (get().root === root) set({ sections: null })
    }
  },
  setWindowWidth: (windowWidth) => set({ windowWidth }),
  loadLists: async () => {
    const root = get().root
    if (!root) { set({ materials: null, artifacts: null, buildTree: null, projectLoad: null }); return }
    const [m, a, tree, load] = await Promise.all([
      rpc.materials(root).catch(() => null),
      rpc.artifacts(root).catch(() => null),
      rpc.buildTree(root).catch(() => null),
      rpc.load(root).catch(() => null)
    ])
    if (get().root !== root) return
    set({ materials: m, artifacts: a ? a.items : null, buildTree: tree, projectLoad: load })
  },
  setPaneView: (paneView) => set({ paneView }),
  focusSection: (focusedSection) => set({ focusedSection }),
  setPaperClosed: (closed) => {
    const root = get().root
    set({ paperClosed: closed })
    if (!root) return
    const prefs = { ...(get().settings?.ui_prefs ?? {}) }
    prefs[root] = { ...prefs[root], paperClosed: closed }
    // 정본 폴더에는 쓰지 않는다 — 앱 설정에만 남긴다(IMPL-PLAN §4-2).
    void window.knuaf.setSettings({ ui_prefs: prefs }).then(() => get().loadSettings())
  },
  open: async (root, opts) => {
    set({ loading: true, error: null, openFailure: null, retryFailed: null })
    const r = await window.knuaf.openProject(root)
    if (r.error) {
      const d = describeError(r.error)
      if (!opts?.local) set({ error: d })
      // 실패한 그 선택의 python·kind 와 재시도 대상 root 를 오류와 함께 보관한다(PY-D1-03).
      // 이전 프로젝트의 store.sidecar 로 판단하면 첫 실패에서 버튼이 서지 않고, 다른 논문을
      // 열었던 세션에서는 틀린 kind 로 판단한다.
      set({ loading: false, openFailure: r.startupFailed && r.sidecar ? { root, sidecar: r.sidecar, code: r.error.code } : null })
      return d
    }
    // 위에서 error 분기를 돌려보냈으므로 result 는 반드시 있다 — 없으면 계약 위반이므로
    // 빈 폴더처럼 다루지 않고 명시적으로 실패한다.
    if (!r.result) {
      const d = describeError({ code: 'internal', message: 'project:open 응답에 result 가 없음' })
      set({ loading: false, error: d })
      return d
    }
    const opened = r.result
    const peek = await window.knuaf.peekProject(root)
    const settings = get().settings
    set({
      root, hasProject: opened.hasProject, sidecar: opened.sidecar, status: null, peek, depsReady: null,
      // 폴더마다 다른 취향이므로 폴더가 바뀌면 여기서 다시 읽는다(전역 settings 는 그대로).
      paperClosed: settings?.ui_prefs?.[root]?.paperClosed === true
    })
    // 시트는 폴더가 바뀌면 닫는다 — 다른 논문의 점검·자료가 떠 있으면 안 된다.
    // 이동은 성공이 확정된 여기서 한다 — 아래 refresh() 는 파이썬 스폰이라 몇 초
    // 걸리는데, 그 사이 학생이 다른 것을 열면 늦게 온 이동이 되돌려 버렸다.
    get().closeSheet()
    stopCanonPoll()
    quietFailures = 0
    // 다른 논문의 이벤트 줄·직전 지문을 들고 가지 않는다.
    sectionHashes = null
    set({ events: [], sections: null, materials: null, artifacts: null, buildTree: null, projectLoad: null, focusedSection: null, paneView: 'chat' })
    canonPoll = setInterval(() => { void get().watchCanon() }, 2000)
    // 도우미가 하위 폴더에 init한 경우 — 빈 화면으로 두지 않고 어디에 만들었는지 알린다.
    const nested = opened.nestedProject
    if (nested) set({ error: { kind: 'warning', title: '도우미가 다른 폴더에 논문을 만들었어요.', action: `"${nested}" 폴더 안에 논문 데이터가 있어요. 그 폴더를 열거나, 이 폴더가 맞으면 도우미에게 이 폴더에서 작업하라고 알려 주세요.`, code: 'nested_project', raw: `${nested}/project.json` } })
    await get().loadSettings()
    if (opened.hasProject) await get().refresh()
    else { set({ loading: false }); set({ sections: null }) }
    // 준비는 폴더를 여는 순간 백그라운드로 시작하고 실패만 표면화한다(03-화면/01 결정).
    // 옮겨 온 폴더도 deps가 비어 있을 수 있으니 매번 확인한다 — 준비됐으면 아무 일도 없다.
    void get().prepareDeps(root)
    // 화면이 쓸 공급자를 **같이 넘긴다** — 안 넘기면 화면이 곧바로 다른 공급자로 다시 읽어
    // 대화를 한 번 비운다(위 chatProviderNow 주석).
    void useChat.getState().load(root, chatProviderNow())
    return null
  },
  /** Quiet deps.ensure after refreshDeps reports not-ready; only a failure is surfaced. */
  prepareDeps: async (root) => {
    await get().refreshDeps()
    if (get().root !== root || get().depsReady !== false) return
    type DepsReply = { result?: { ok?: boolean; block_reason?: string | null; stderr?: string }; error?: { code?: string; message?: string } }
    // 준비하는 동안 대화 전송은 기다리고 화면은 진행 표시를 띄운다(store/prep.ts).
    usePrep.getState().begin(root)
    const r: DepsReply = await window.knuaf.depsEnsure(root).catch((e: unknown) => ({ error: { message: String(e) } }))
      .finally(() => usePrep.getState().end(root))
    if (get().root !== root) return
    if ('result' in r && r.result?.ok) { void get().refreshDeps(); return }
    // 터미널 도우미가 작업 중이면 sidecar가 쓰기를 거절한다 — 실패가 아니라 바쁨이니 조용히 넘긴다.
    if ('error' in r && r.error?.code === 'agent_busy') return
    const detail = 'result' in r
      ? (r.result?.block_reason ?? r.result?.stderr?.trim().split('\n').filter(Boolean).at(-1) ?? 'deps.ensure failed')
      : String(r.error?.message ?? 'deps.ensure failed')
    set({ error: { kind: 'warning', title: CHAT.prepFailedTitle, action: '"설정 > 문제 해결"의 "준비 상태"를 확인해 주세요.', code: 'deps_ensure', raw: detail } })
  },
  /**
   * hasProject 와 status 는 폴더를 열 때 한 번 정해진다. 도우미가 그 뒤에 정본을
   * 만들면 앱은 모른 채 왼쪽 메뉴를 잠가 두었고(GUI 감사 GUI-02), 정본을 고쳐도
   * 점검 화면은 옛 숫자를 계속 내보였다.
   *
   * 채팅 스냅샷에 매달지 않는 이유: 정본을 바꾸는 길이 앱 안 채팅만은 아니다. 학생이
   * 외부 터미널에서 스킬을 돌려도 정본은 바뀌고, 그때는 스냅샷이 오지 않는다.
   * 그래서 "누가 바꿨는지"를 묻지 않고 파일만 본다.
   *
   * refresh() 를 바로 부르지 않는 이유: 정본이 없는 폴더에서는 status 가 실패해
   * 일어나지도 않은 오류를 띄운다. 존재를 먼저 보고, 바뀌었을 때만 제대로 읽는다.
   */
  watchCanon: async () => {
    const root = get().root
    if (!root) { stopCanonPoll(); return }
    const peek = await window.knuaf.peekProject(root)
    if (get().root !== root) return
    set({ peek })
    // 두 번 잇따라 실패해 화면에 오류가 떠 있으면 되풀이하지 않는다. 학생이 새로고침을
    // 누르면 다시 센다 — 읽히지 않는 정본으로 2초마다 사이드카를 띄우지 않기 위함이다.
    if (!peek.hasProject || statusInFlight || quietFailures >= 2) return
    // 정본이 처음 보이면 한 번 읽는다. 그 뒤로는 개정 번호가 달라졌을 때만 읽는다 —
    // 번호를 못 읽으면(깨진 파일) 바뀐 줄 알 길이 없으니 되풀이하지 않는다.
    const moved = peek.revision != null && peek.revision !== get().status?.revision
    if (get().hasProject && !moved) return
    await get().refresh({ quiet: true })
  },
  refresh: async (opts) => {
    const root = get().root
    if (!root) return
    // 학생이 직접 누른 새로고침은 감시 타이머의 실패 횟수도 다시 센다(위 물러섬 해제).
    if (!opts?.quiet) { quietFailures = 0; set({ loading: true, error: null }) }
    statusInFlight = true
    try {
      const status = await rpc.status(root)
      const peek = await window.knuaf.peekProject(root)
      if (get().root !== root) return
      quietFailures = 0
      set({ status, peek, hasProject: true, loading: false, refreshSeq: get().refreshSeq + 1 })
      // 종이 칸·머리가 같은 목록을 본다 — 화면마다 따로 읽으면 한 곳만 갱신된다.
      void get().loadSections()
      void get().loadLists()
    } catch (e) {
      // 조용한 갱신의 첫 실패는 삼킨다 — 도우미가 쓰는 중이면 곧 풀린다. 두 번째부터는
      // 말한다: 화면의 숫자가 디스크의 정본보다 뒤처진 채 조용히 남는 것이 가장 나쁘다.
      if (opts?.quiet && ++quietFailures < 2) return
      set({ error: describeError(e), loading: false })
    } finally { statusInFlight = false }
  },
  retryOpen: async (root, onOpened) => {
    const err = await get().open(root, { local: true })
    if (!err) { await onOpened?.(root); return true }
    // 새 오류는 전역 error 로 올려 화면이 그대로 보여 준다. 설치 성공과 복구 실패를 함께
    // 말하는 문구는 retryFailed 가 맡는다 — 이 값은 컴포넌트가 아니라 store 에 산다.
    set({ error: err, retryFailed: { root } })
    return false
  },
  refreshSidecar: async () => set({ sidecar: await window.knuaf.sidecarInfo() }),
  refreshDeps: async () => {
    const root = get().root
    if (!root) return
    try { const d = await rpc.doctor(root); set({ depsReady: !!d.deps?.ready }) } catch { set({ depsReady: null }) }
  },
  // 오류 카드를 닫으면 그 요청의 실패 정보·복구 실패 표시도 같이 지운다 — 버튼이 사라진 뒤
  // 재시도 대상만 남지 않게.
  clearError: () => set({ error: null, openFailure: null, retryFailed: null }),
  helper: { open: false, status: null, result: null, error: null },
  openHelper: async () => {
    set({ helper: { open: true, status: null, result: null, error: null } })
    const r = await window.knuaf.agentStatus(get().root)
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, status: r.result } }))
    const st = r.result
    if (st.claude.found && !st.codex.found) await get().launchHelper('claude')
    else if (!st.claude.found && st.codex.found) await get().launchHelper('codex')
  },
  launchHelper: async (kind) => {
    const { root, status, peek } = get()
    if (!root) { set((s) => ({ helper: { ...s.helper, error: describeError({ code: 'not_found', message: '먼저 폴더를 열어 주세요' }) } })); return }
    const r = await window.knuaf.agentLaunch({ root, kind, revision: status?.revision ?? peek?.revision ?? null })
    if (r.error) { set((s) => ({ helper: { ...s.helper, error: describeError(r.error) } })); return }
    set((s) => ({ helper: { ...s.helper, result: { title: HELPER.launchedTitle, body: undefined, kind } } }))
  },
  closeHelper: () => set((s) => ({ helper: { ...s.helper, open: false } })),
  pushLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  clearLogs: () => set({ logs: [] })
}))
