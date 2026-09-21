/**
 * 앱 표시이름(productName/CFBundleDisplayName)이 바뀌면 Electron 의 userData 경로가
 * 새 폴더로 이동하고, 옛 폴더의 settings.json — 최근 폴더·Python 설정·도우미 선택·
 * 신뢰 폴더 — 이 조용히 남는다. 학생 입장에서는 앱 업데이트 한 번에 모든 것이
 * 초기화된 것처럼 보인다.
 *
 * 이름을 바꾼 적이 있으면 첫 실행 때 옛 폴더에서 settings.json 만 가져온다.
 * 새 폴더에 이미 설정이 있으면 건드리지 않고(새 쪽이 이기고), 옛 폴더는 삭제하지
 * 않는다 — 복사만 하고 원본은 그대로 둔다.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 앱 표시이름이 또 바뀌면 그 시점의 옛 userData 폴더 이름을 여기에 추가한다.
 * 이름은 `<appData>/<이름>` 으로 해석된다(모든 플랫폼에서 같은 규칙).
 */
export const LEGACY_USERDATA_NAMES = [
  'KNUAF Thesis Helper', // 2026-09-20~09-21 설치판(CFBundleName)
  '한농대 창업논문 헬퍼',    // 같은 기간의 표시이름 — 개발 모드가 이쪽에 만들기도 했다
  'knuaf-doc 동반 앱',    // 그 전 설치판
  'knuaf-doc Companion'  // 그 전 개발 모드
]
// 2026-09-20 개명("한농대 창업논문 헬퍼") 때 실측: 설치판의 새 폴더는 표시이름이 아니라
// CFBundleName(= productName)으로 생겼고, 옛 이름에서 settings.json 을 가져오는 것까지
// 확인했다(credit_shown_at 가 그대로 넘어왔다). 2026-09-21 "KNUAF-Dev" 개명 때 두 이름을
// 앞에 더했다 — 최근 폴더·권한 설정이 날아가지 않게 한다. 먼저 찾은 것을 쓰므로 새 것부터 적는다.

/**
 * current 에 settings.json 이 없고 legacy 중 하나에 있으면 복사해 온다.
 * 가져온 원본 경로를 돌려주고, 아무 일도 없었으면 null.
 * 순수 함수 — 테스트는 임시 디렉터리로 돌린다(e2e/userdata.spec.ts).
 */
export function migrateUserDataDir(current: string, legacyDirs: string[]): string | null {
  const target = join(current, 'settings.json')
  if (existsSync(target)) return null
  for (const dir of legacyDirs) {
    const from = join(dir, 'settings.json')
    if (!existsSync(from)) continue
    mkdirSync(current, { recursive: true })
    copyFileSync(from, target)
    return from
  }
  return null
}
