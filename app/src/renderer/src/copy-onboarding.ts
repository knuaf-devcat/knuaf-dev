import type { ConnState } from './store/connect'
import type { Provider } from '../../shared/chat'

/**
 * 첫 실행 화면(AI 연결 ① → 논문 폴더 ②)의 문구.
 *
 * copy.ts 가 아니라 여기 있는 이유는 둘이다. (1) 동시에 작업하는 단계 1 워커가 copy.ts 를
 * 쥐고 있다 — 발주 ③ 의 파일 소유 경계. (2) e2e/invariants.spec.ts 는 `screens/`·`components/`
 * 안의 `.tsx` 에 한글이 있으면 copy.ts 로 옮기라고 잡아낸다(270건 고정). 화면 파일이 아니라
 * 이 모듈에 두면 그 규칙을 건드리지 않고, 합류 뒤에는 copy.ts 의 ONBOARD 절로 그대로 옮긴다.
 *
 * 문구 규칙은 DESIGN §5·§6 을 따른다: 기술 이름(Codex·Claude Code)은 설치가 필요할 때만
 * 괄호로 붙이고, 기본 화면에는 쓰지 않는다.
 */
export const NAME: Record<Provider, string> = { codex: 'ChatGPT', claude: 'Claude' }
export const TOOL: Record<Provider, string> = { codex: 'Codex', claude: 'Claude Code' }

export const ONBOARD = {
  guideConnect: 'AI 연결',
  guideConnectDone: 'AI 연결 ✓',
  guideFolder: '논문 폴더',
  guideStart: '시작',
  connectTitle: '먼저, 쓰고 있는 AI를 연결해요',
  connectIntro: '평소 쓰는 ChatGPT나 Claude 계정 하나면 돼요. 이 앱은 AI 이용권을 따로 팔지 않아요 — 도우미는 내 계정으로 일해요.',
  recommended: '권장',
  claudeExperimental: '아직 실험 중인 연결이에요',
  chosenSuffix: ' · 고른 AI예요',
  installGuide: '설치 안내',
  loginAs: (name: string) => `${name}로 로그인`,
  reopenBrowser: '브라우저 다시 열기',
  cancel: '취소',
  startWith: '이걸로 시작',
  connectNext: '다음 — 논문 폴더 고르기',
  connectWaiting: '연결이 확인되면 다음으로 갈 수 있어요.',
  howToChoose: '둘 다 있나요? 어느 쪽이 좋은지 보기',
  folderBack: '← AI 연결',
  folderTitle: '논문을 담을 폴더를 골라요',
  folderIntro: '논문 글과 자료가 이 폴더에 모여요. 이미 가진 원고나 엑셀이 있는 폴더도 괜찮아요 — 원래 파일은 건드리지 않아요.',
  newName: '새로 시작',
  newBody: '빈 폴더를 만들어요',
  newAction: '새 폴더 만들기',
  recentName: '쓰던 논문 이어 쓰기',
  recentBody: '전에 쓰던 폴더를 열어요',
  recentAction: '폴더 열기',
  recents: '최근',
  folderFoot: '폴더를 이 창에 끌어다 놓아도 열려요. 연결한 AI는 나중에 설정에서 바꿀 수 있어요.',
  toolHint: '연결 도구를 설치한 뒤 이 화면으로 돌아와 "다시 확인"을 눌러 주세요.'
} as const

/**
 * 상태 한 줄 — 관찰한 것만 말한다. 확인하지 못한 것을 연결됨·끊김으로 꾸미지 않는다(R5 §6.3).
 * `checking` 은 첫 그림이고, `failed`(도구는 있는데 대답을 못 들음)와 `unknown`(요청 자체가
 * 실패)을 "로그인이 필요해요"로 접지 않는다.
 */
export function stateLine(provider: Provider, state: ConnState): string {
  switch (state) {
    case 'checking': return '연결 상태를 확인하고 있어요'
    case 'no-tool': return `연결 도구(${TOOL[provider]})를 먼저 설치해요`
    case 'need-login': return `${NAME[provider]} 계정 로그인이 필요해요`
    case 'logging-in': return '브라우저에서 로그인한 뒤 이 창으로 돌아와 주세요'
    case 'connected': return '연결됐어요'
    case 'failed': return '연결 상태를 확인하지 못했어요'
    default: return '연결 상태를 알 수 없어요'
  }
}
