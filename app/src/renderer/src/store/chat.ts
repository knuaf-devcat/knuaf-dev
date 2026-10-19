import { create } from 'zustand'
import { isPreparing, waitPrepared } from './prep'
import { beginLoginAttempt, connInfoOf, loginAttemptLive, startPoll, stopPoll, type ConnState } from './connect'
import type { ChatSnapshot, ConnectionStatus, Provider } from '../../../shared/chat'

/** 어떤 도우미로 채팅하는지. 인앱 터미널 모드는 제거됐다 — 내 논문은 항상 앱 채팅이다. */
export type ChatMode = 'codex-chat' | 'claude-chat'

export function chatProvider(mode: ChatMode): Provider {
  return mode === 'claude-chat' ? 'claude' : 'codex'
}

/**
 * Effective mode: a session pick (`mode`) wins; then the persisted `helper_mode`.
 * main 의 loadSettings 가 옛 *-term 값을 채팅으로 옮겨 주지만, 디스크 값이 그대로
 * 도착하는 경우(마이그레이션 전 상태를 주입하는 테스트 등)를 위해 여기서도 한 번 더
 * 정규화한다 — term 은 공급자를 보존한 채 chat 으로.
 */
export function resolveChatMode(mode: ChatMode | null, settings: { helper_mode?: string | null } | null): ChatMode {
  if (mode) return mode
  const h = settings?.helper_mode
  if (h === 'claude-chat' || h === 'claude-term') return 'claude-chat'
  return 'codex-chat'
}

type Reply<T> = { result: T } | { error: { code: string; message: string } }

function messageOf(r: Reply<unknown>): string | null {
  return 'error' in r && r.error ? r.error.message : null
}

/**
 * 전송이 끝난 뒤 초안을 무엇으로 둘지.
 *
 * main 은 실행 중 스냅샷을 먼저 보내고 전송 응답을 나중에 돌려준다(service.ts). 그래서
 * 응답이 돌아올 때까지 학생이 다음 말을 쓸 수 있고, 그때 성공했다고 초안을 비우면 그
 * 글이 사라진다(검토 IMPL-R1-01). 문자열 비교로는 "같은 문장을 지웠다 다시 쓴" 경우를
 * 구분할 수 없다 — 초안 편집 번호(`draftSeq`)를 비교한다.
 */
export function draftAfterSend(seqAtSend: number, seqNow: number, current: string): string {
  return seqNow === seqAtSend ? '' : current
}

/**
 * 연결 상태 IPC 응답 하나를 화면 상태로 옮긴다.
 *
 * `probe:'failed'`(도구는 있는데 대답을 못 들음)를 "로그인 필요"로 접으면 화면이 잘못된
 * 재인증을 요구한다(P2-R1-01). 판정은 온보딩과 **같은 함수**(`connInfoOf`)를 쓴다 —
 * 두 곳에 각자 적어 두면 한쪽만 고쳐진다. IPC 자체가 실패한 것은 `unknown` 이다.
 */
function statusInfo(r: Reply<ConnectionStatus>): { status: ConnectionStatus | null; statusFailed: boolean; connState: ConnState } {
  if (!('result' in r)) return { status: null, statusFailed: true, connState: 'unknown' }
  return { status: r.result, statusFailed: false, connState: connInfoOf(r.result).state }
}

interface ChatState {
  root: string | null
  provider: Provider
  snapshot: ChatSnapshot | null
  status: ConnectionStatus | null
  /** status 호출 자체가 실패 — 확정된 실패지 "확인 중"이 아니다. 가짜 status를 만들지 않고 구분한다. */
  statusFailed: boolean
  /** 연결 상태 이름 — 화면이 무엇을 보일지 정한다(온보딩과 같은 판정: `connInfoOf`). */
  connState: ConnState
  draft: string
  /** 초안 편집 번호 — 학생이 초안을 바꾼 모든 경로가 1씩 올린다(`draftAfterSend` 판정용). */
  draftSeq: number
  busy: boolean
  /** 폴더 준비가 끝나기를 기다렸다가 보내는 중(store/prep.ts) — 화면이 진행 표시를 띄운다. */
  waitingPrep: boolean
  /**
   * 대화 방문 번호 — 폴더나 공급자가 바뀔 때마다 1씩 오른다. 늦게 끝난 전송·준비 대기가 **그것을 시작한
   * 방문**에만 속하게 한다: 떠난 뒤에는 보내지 않고, 새 방문의 잠금·진행 표시를 건드리지 않는다
   * (검토 WINFB-R1-01 — 끝난 시점의 root 만 비교하면 A→B→A 에서 옛 요청이 나갔다).
   */
  visit: number
  error: string | null
  /** Session override; null = follow settings.helper_mode / codex_terminal. */
  mode: ChatMode | null
  /**
   * 온보딩 2단계에서 폴더를 고른 순간의 **시작 의사**(그 폴더 경로). 그 폴더의 대화가
   * 비어 있으면 Chat 이 한 번만 첫 마디를 보낸다 — 학생이 "여기서 시작하겠다"고 고른 것이
   * 곧 시작 의사다. 다시 열었을 때는 걸리지 않는다(빈 대화 단추를 남긴다).
   */
  startIntent: string | null
  armStart: (root: string) => void
  disarmStart: () => void
  setMode: (mode: ChatMode | null) => void
  setDraft: (draft: string) => void
  /** Append a picked/dropped file path to the draft as plain text — nothing else happens. */
  insertPath: (path: string) => void
  /**
   * Append a prepared request (e.g. 점검의 "고쳐달라기") to the draft, keeping whatever the
   * student was typing. Never replaces — same join rule as insertPath. Never sends: the send
   * button stays under the student's finger, and when the helper is busy the gate already
   * holds it.
   */
  appendDraft: (text: string) => void
  clearError: () => void
  load: (root: string, provider?: Provider) => Promise<void>
  refreshStatus: () => Promise<void>
  login: () => Promise<void>
  /** Send `text` (defaults to the draft) with a fresh requestId; clears the draft on acceptance.
   *  Returns false when the send was refused — the question card unlocks itself on refusal.
   *  `opts.consumeDraft` — 보기를 눌러 보낸 것이 아니라 **초안을 소비하는** 전송(인용 합치기)임을
   *  알린다. 그러면 명시적 `text` 라도 일반 전송과 같은 `draftSeq` 규칙으로 그 초안만 비운다
   *  — 전송 중 새로 쓴 글은 지키면서(검토 QA2B-R1-02). */
  send: (text?: string, opts?: { consumeDraft?: boolean }) => Promise<boolean>
  respond: (id: string, allow: boolean) => Promise<void>
  stop: () => Promise<void>
  /** Push target for window.knuaf.onChatSnapshot; ignores snapshots for other roots/providers. */
  onSnapshot: (snapshot: ChatSnapshot) => void
}

export const useChat = create<ChatState>((set, get) => ({
  root: null,
  provider: 'codex',
  snapshot: null,
  status: null,
  statusFailed: false,
  connState: 'checking',
  draft: '',
  draftSeq: 0,
  busy: false,
  waitingPrep: false,
  visit: 0,
  error: null,
  mode: null,
  startIntent: null,
  armStart: (root) => set({ startIntent: root }),
  disarmStart: () => set({ startIntent: null }),
  setMode: (mode) => set({ mode, ...(mode ? { provider: chatProvider(mode) } : {}) }),
  setDraft: (draft) => { set((s) => ({ draft, draftSeq: s.draftSeq + 1 })); const r = get().root; if (r) void window.knuaf.chat.setDraft(r, draft) },
  insertPath: (path) => {
    const d = get().draft
    get().setDraft(d ? (d.endsWith('\n') ? d + path : d + '\n' + path) : path)
  },
  appendDraft: (text) => get().insertPath(text),
  clearError: () => set({ error: null }),
  load: async (root, provider = get().provider) => {
    // 폴더·공급자가 바뀌면 **이전 대화의** 로그인 기다림만 끝난다(규칙은 store/connect 한 곳에 있다).
    // 첫 화면이 다른 공급자의 로그인을 지켜보고 있어도 여기서 끊기지 않는다(W2 D1).
    stopPoll(get().provider)
    // 초안을 비우는 것은 폴더가 바뀔 때뿐이다 — A 에 쓰다 만 답변이 B 에 그대로
    // 보이는 것을 막는 게 목적이다(GUI-01). 같은 폴더의 재로드(공급자 전환, 첫 로드가
    // 끝나기 전 채팅 화면 마운트가 load 를 한 번 더 부르는 경주)에서까지 비우면 그
    // 사이 붙인 첨부 경로나 쓴 글이 말없이 사라진다.
    const switching = get().root !== root
    /**
     * **같은 폴더·같은 공급자를 다시 읽을 때는 이미 보여 준 대화·연결 상태를 비우지 않는다.**
     *
     * 예전에는 매 `load()` 가 `snapshot: null` 을 먼저 넣어, 다시 읽는 동안 대화 목록이 통째로
     * 사라졌다가 새로 그려졌다(재마운트). 그 사이 학생이 펼쳐 둔 긴 답변이 접히고, 아래 칸이
     * "연결 확인 중…"으로 깜빡이며, 시험이 잰 좌표·누른 자리가 낡는다 — 느린 기계(맥 CI)에서
     * 드러난 공통 원인이다. 폴더나 공급자가 실제로 바뀔 때만 비운다(다른 대화를 섞지 않는다).
     */
    const samePair = !switching && get().provider === provider
    set({
      root, provider, error: null,
      // 다른 대화로 옮기면 새 방문이다 — 앞 방문의 전송·준비 대기가 쥐고 있던 잠금과 진행 표시를 푼다.
      ...(samePair ? {} : { snapshot: null, status: null, statusFailed: false, connState: 'checking', visit: get().visit + 1, busy: false, waitingPrep: false }),
      ...(switching ? { draft: '', draftSeq: get().draftSeq + 1 } : {})
    })
    // 이 읽기를 **시작한 시점**의 화면. 늦게 도착한 응답이 그 뒤에 앱이 스스로 바꾼 값
    // (전송으로 새 메시지가 붙음 · 도착 스냅샷 반영 · 학생이 초안을 씀/보내 비움)을 되돌리면
    // 보낸 글이 화면에서 사라지고 소비한 초안이 미전송 글처럼 되살아난다(검토 MACR3-R1-01).
    const snapAtStart = get().snapshot
    const draftAtStart = get().draft
    const draftSeqAtStart = get().draftSeq
    const [snap, st, saved] = await Promise.all([
      window.knuaf.chat.snapshot(root, provider) as Promise<Reply<ChatSnapshot>>,
      window.knuaf.chat.status(root, provider) as Promise<Reply<ConnectionStatus>>,
      window.knuaf.chat.draft(root) as Promise<Reply<string>>
    ])
    if (get().root !== root || get().provider !== provider) return
    // 화면에 이미 무언가 있으면 그게 최신이다 — 디스크 값으로 덮지 않는다. 기다리는
    // 동안 학생이 입력했거나 자료 화면이 경로를 넣은 경우다(status() 가 도우미
    // 바이너리를 찾느라 몇 초씩 걸려 틈이 넓다).
    //
    // 여기서 switching 을 조건에 넣으면 안 된다. 앱을 새로 띄우면 load() 가 두 번
    // 도는데(스토어 기본 provider → 설정이 정한 provider), 첫 번째는 provider 가
    // 달라져 위 가드에서 빠지고 두 번째는 switching 이 false 라 건너뛰어 아무도
    // 복원하지 않았다. 기준은 "같은 폴더인가"가 아니라 "화면에 학생 것이 있는가"다.
    //
    // 위 기준에 **"읽기 시작 뒤에 움직였는가"** 를 더한다: 그 사이 메시지가 갱신됐으면
    // 이 읽기의 옛 snapshot 은 버리고, 초안이 편집·소비됐으면 이 읽기의 저장 초안은 버린다.
    // 연결 상태(status)는 이 읽기의 최신 판단이므로 그대로 반영한다.
    const snapMoved = get().snapshot !== snapAtStart
    const draftMoved = get().draftSeq !== draftSeqAtStart || get().draft !== draftAtStart
    const savedDraft = 'result' in saved ? saved.result : ''
    set({
      ...(snapMoved ? {} : { snapshot: 'result' in snap ? snap.result : null }),
      ...statusInfo(st),
      // 디스크 값을 불러오는 것도 초안 편집으로 센다(설계 §4-1).
      ...(draftMoved || get().draft !== '' ? {} : { draft: savedDraft, draftSeq: get().draftSeq + 1 }),
      error: messageOf(snap) ?? messageOf(st)
    })
  },
  refreshStatus: async () => {
    const { root, provider } = get()
    if (!root) return
    const st = await window.knuaf.chat.status(root, provider) as Reply<ConnectionStatus>
    if (get().provider !== provider) return
    const info = statusInfo(st)
    // 확인 요청 자체가 실패했으면 직전에 본 상태를 그대로 두고 'unknown' 만 말한다.
    set({ status: info.status ?? get().status, statusFailed: info.statusFailed, connState: info.connState, error: messageOf(st) })
  },
  login: async () => {
    const { root, provider } = get()
    if (!root) return
    // 이 방문(visit)과 이 공급자의 시도 표를 들고 시작한다. 응답은 브라우저 왕복 뒤에 오므로,
    // 그 사이 학생이 다른 폴더·공급자로 떠났거나 같은 공급자의 새 로그인을 시작했을 수 있다.
    const mine = beginLoginAttempt(provider)
    const visitAtStart = get().visit
    stopPoll(provider)   // 같은 공급자의 이전 기다림만 끝낸다 — 다른 공급자의 로그인은 건드리지 않는다
    set({ busy: true, error: null })
    const r = await window.knuaf.chat.login(root, provider) as Reply<true>
    /**
     * 옛 응답은 지금 화면의 것이 아니다 — 상태도 폴링도 건드리지 않는다(R2-C01).
     * 예전에는 무조건 `startPoll` 을 불러, 늦게 도착한 폴더 로그인 응답이 그 사이 계정 팝오버가
     * 시작한 **새** 로그인의 감시를 갈아 끼웠다. 그 새 타이머는 첫 tick 에서 "공급자가 바뀌었다"를
     * 보고 스스로 꺼져, 실제로는 로그인 중인데 감시가 하나도 남지 않았다.
     *
     * `busy` 도 여기서 내리지 않는다 — 새 시도가 아직 진행 중이면 그 표시는 그 시도의 것이다.
     * (폴더·공급자를 떠난 경우는 `load` 가 이미 `busy` 를 풀었다.)
     */
    if (get().visit !== visitAtStart || get().provider !== provider || !loginAttemptLive(provider, mine)) return
    set({ busy: false, error: messageOf(r) })
    if ('error' in r && r.error) return
    // 브라우저 로그인은 오래 걸린다 — 3초마다, 3분까지. 이 폴더의 연결 상태를 다시 본다.
    startPoll(provider, async () => {
      if (get().provider !== provider) return true   // 공급자가 바뀌었으면 이 기다림은 끝난 것이다
      await get().refreshStatus()
      return get().status?.connected === true
    })
  },
  send: async (text, opts) => {
    const { root, provider, draft } = get()
    const body = (text ?? draft).trim()
    if (!root || !body) return false
    // 보낼 때의 폴더·공급자와 초안 편집 번호. 응답은 몇 초 뒤에 온다 — 그 사이 학생이 다른
    // 논문을 열었을 수 있고, 그러면 이 응답은 지금 화면의 것이 아니다(검토 P1-R1-01).
    // 저장할 초안의 소유 폴더는 늘 `setDraft` 에 넘기는 root 여야 한다.
    const seqAtSend = get().draftSeq
    const rootAtSend = root
    const providerAtSend = provider
    const visitAtSend = get().visit
    const left = (): boolean => get().visit !== visitAtSend
    set({ busy: true, error: null })
    // 폴더 준비 중이면 main 이 전송을 거절한다 — 거절당하지 않고 끝날 때까지 기다렸다 보낸다.
    // 그 사이 다른 대화로 떠나면 보내지 않는다. 잠금·진행 표시는 새 방문을 연 `load` 가 이미 풀었다.
    if (isPreparing(root)) {
      set({ waitingPrep: true })
      const ready = await waitPrepared(root, left, (check) => useChat.subscribe(check))
      // 준비가 끝난 뒤 이 줄로 돌아오기 전에도 방문이 바뀔 수 있다 — 상태를 바꾸거나 보내기 **전에**
      // 다시 본다(검토 확인 WINFB-R1-01: 준비 완료와 폴더 전환이 맞물리면 떠난 요청이 나갔다).
      if (!ready || left()) return false
      set({ waitingPrep: false })
    }
    const requestId = crypto.randomUUID()
    const r = await window.knuaf.chat.send(root, provider, body, requestId) as Reply<ChatSnapshot>
    // 폴더·공급자가 달라졌으면 스냅샷도 초안도 지금 화면에 적용하지 않는다. 다른 폴더의
    // 늦은 성공이 지금 논문의 미전송 초안을 덮거나, 그 초안을 원래 폴더 파일에 쓰면 안 된다.
    if (left() || get().root !== rootAtSend || get().provider !== providerAtSend) {
      // 떠난 방문의 응답 — 새 방문의 잠금은 그 방문의 것이다(load 가 이미 풀었다).
      if (!left()) set({ busy: false })
      return 'result' in r
    }
    if ('result' in r) {
      // 보기를 눌러 보낸 `send(text)` 는 초안을 건드리지 않는다 — 학생이 쓰던 글이 남는다.
      // 인용을 합쳐 보낸 경우(`consumeDraft`)는 그 초안을 **소비**하므로 일반 전송과 같은
      // `draftSeq` 규칙을 쓴다 — 보낸 글이 입력칸에 남지 않고, 그 사이 새로 쓴 글은 지켜진다.
      const keep = (text === undefined || opts?.consumeDraft)
        ? draftAfterSend(seqAtSend, get().draftSeq, get().draft)
        : get().draft
      set({ busy: false, snapshot: r.result, draft: keep })
      void window.knuaf.chat.setDraft(root, keep)
      return true
    }
    set({ busy: false, error: messageOf(r) })
    return false
  },
  respond: async (id, allow) => {
    const { root, provider } = get()
    if (!root) return
    const r = await window.knuaf.chat.respond(root, provider, id, allow) as Reply<true>
    set({ error: messageOf(r) })
  },
  stop: async () => {
    const { root, provider } = get()
    if (!root) return
    const r = await window.knuaf.chat.stop(root, provider) as Reply<true>
    set({ error: messageOf(r) })
  },
  onSnapshot: (snapshot) => {
    if (snapshot.root === get().root && snapshot.provider === get().provider) set({ snapshot })
  }
}))
