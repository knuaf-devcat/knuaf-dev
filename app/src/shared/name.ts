/**
 * 앱 이름. 주 프로세스·렌더러가 전부 여기서 가져간다.
 *
 * 보이는 이름과 식별자를 나눈다 — macOS 앱 이름은 대문자로 시작하는 것이 관례이고,
 * 저장소·폴더·내려받는 파일 이름은 소문자가 관례다.
 *
 * `electron-builder.yml` 은 TS 를 읽지 못해 같은 문자열을 따로 적는다 —
 * 어긋나지 않도록 `e2e/invariants.spec.ts` 가 둘이 같은지 본다.
 */

/** 이름의 앞 토막. 사이드바처럼 두 줄로 앉히는 자리에서 첫 줄이 된다. */
export const APP_NAME_SHORT = 'KNUAF-Dev'

/** 이름의 뒤 토막. 무엇을 하는 앱인지가 여기 있다. */
export const APP_NAME_KO = '창업논문 작성 도우미'

/** 한 줄로 쓰는 전체 이름. 가운뎃점은 U+00B7 이다(U+2022 불릿이나 마침표가 아니다). */
export const APP_NAME = `${APP_NAME_SHORT} · ${APP_NAME_KO}`

/**
 * 파일 이름·번들 식별에 쓰는 ASCII 이름. `productName` 과 같아야 한다 —
 * 한글을 쓰면 헬퍼 번들이 "… 도우미 Helper.app" 이 되어 앱이 시작하자마자 죽는다.
 * 설치판의 userData 폴더 이름도 여기서 온다.
 */
export const APP_NAME_ASCII = 'knuaf-dev'
