import { create } from 'zustand'
import type { ProjectPeek, Settings, SidecarInfo, Status } from '../../../shared/types'
import { CHAT, describeError, type DescribedError } from '../copy'
import { rpc } from '../rpc'
import { useChat } from './chat'

export type Screen = 'chat' | 'materials' | 'artifacts' | 'checkup' | 'settings'

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
  sidecar: (SidecarInfo & { basePython?: string; wheelhouse?: string | null }) | null
  settings: Settings | null
  screen: Screen
  settingsFocus: SettingsFocus
  logs: { stream: string; line: string }[]
  setScreen: (s: Screen) => void
  /** Navigate to 설정 with a disclosure preset open (deep link from failure feedback). */
  openSettings: (focus?: SettingsFocus) => void
  clearSettingsFocus: () => void
  loadSettings: () => Promise<void>
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
  helper: { open: boolean; status: any | null; result: { title: string; body?: string } | null; error: DescribedError | null }
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
  sidecar: null,
  settings: null,
  screen: 'chat',
  settingsFocus: null,
  logs: [],
  setScreen: (screen) => { set({ screen, ...(screen === 'settings' ? {} : { settingsFocus: null }) }); location.hash = screen },
  openSettings: (focus = null) => { set({ screen: 'settings', settingsFocus: focus }); location.hash = 'settings' },
  clearSettingsFocus: () => set({ settingsFocus: null }),
  loadSettings: async () => set({ settings: await window.knuaf.getSettings() }),
  open: async (root, opts) => {
    set({ loading: true, error: null })
    const r = await window.knuaf.openProject(root)
    if (r.error) {
      const d = describeError(r.error)
      if (!opts?.local) set({ error: d })
      set({ loading: false })
      return d
    }
    const peek = await window.knuaf.peekProject(root)
    set({ root, hasProject: r.result.hasProject, sidecar: r.result.sidecar, status: null, peek, depsReady: null })
    // 이동은 성공이 확정된 여기서 한다 — 아래 refresh() 는 파이썬 스폰이라 몇 초
    // 걸리는데, 그 사이 학생이 다른 메뉴를 누르면 늦게 온 setScreen 이 되돌려 버렸다.
    get().setScreen('chat')
    stopCanonPoll()
    quietFailures = 0
    canonPoll = setInterval(() => { void get().watchCanon() }, 2000)
    // 도우미가 하위 폴더에 init한 경우 — 빈 화면으로 두지 않고 어디에 만들었는지 알린다.
    const nested = (r.result as { nestedProject?: string | null }).nestedProject
    if (nested) set({ error: { kind: 'warning', title: '도우미가 다른 폴더에 논문을 만들었어요.', action: `"${nested}" 폴더 안에 논문 데이터가 있어요. 그 폴더를 열거나, 이 폴더가 맞으면 도우미에게 이 폴더에서 작업하라고 알려 주세요.`, code: 'nested_project', raw: `${nested}/project.json` } })
    await get().loadSettings()
    if (r.result.hasProject) await get().refresh(); else set({ loading: false })
    // 준비는 폴더를 여는 순간 백그라운드로 시작하고 실패만 표면화한다(03-화면/01 결정).
    // 옮겨 온 폴더도 deps가 비어 있을 수 있으니 매번 확인한다 — 준비됐으면 아무 일도 없다.
    void get().prepareDeps(root)
    void useChat.getState().load(root)
    return null
  },
  /** Quiet deps.ensure after refreshDeps reports not-ready; only a failure is surfaced. */
  prepareDeps: async (root) => {
    await get().refreshDeps()
    if (get().root !== root || get().depsReady !== false) return
    type DepsReply = { result?: { ok?: boolean; block_reason?: string | null; stderr?: string }; error?: { code?: string; message?: string } }
    const r: DepsReply = await window.knuaf.depsEnsure(root).catch((e: unknown) => ({ error: { message: String(e) } }))
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
      set({ status, peek, hasProject: true, loading: false })
    } catch (e) {
      // 조용한 갱신의 첫 실패는 삼킨다 — 도우미가 쓰는 중이면 곧 풀린다. 두 번째부터는
      // 말한다: 화면의 숫자가 디스크의 정본보다 뒤처진 채 조용히 남는 것이 가장 나쁘다.
      if (opts?.quiet && ++quietFailures < 2) return
      set({ error: describeError(e), loading: false })
    } finally { statusInFlight = false }
  },
  refreshSidecar: async () => set({ sidecar: await window.knuaf.sidecarInfo() }),
  refreshDeps: async () => {
    const root = get().root
    if (!root) return
    try { const d = await rpc.doctor(root); set({ depsReady: !!d.deps?.ready }) } catch { set({ depsReady: null }) }
  },
  clearError: () => set({ error: null }),
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
    set((s) => ({ helper: { ...s.helper, result: { title: '터미널 창에서 AI 도우미가 열렸어요', body: undefined } } }))
  },
  closeHelper: () => set((s) => ({ helper: { ...s.helper, open: false } })),
  pushLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),
  clearLogs: () => set({ logs: [] })
}))
