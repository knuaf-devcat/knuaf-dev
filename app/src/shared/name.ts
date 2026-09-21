/**
 * 앱 이름. 주 프로세스·렌더러가 전부 여기서 가져간다.
 *
 * `electron-builder.yml` 은 TS 를 읽지 못해 같은 문자열을 따로 적는다 —
 * 어긋나지 않도록 `e2e/invariants.spec.ts` 가 둘이 같은지 본다.
 *
 * 가운뎃점은 U+00B7 이다(U+2022 불릿이나 마침표가 아니다).
 */
export const APP_NAME = 'KNUAF-Dev · 창업논문 작성 도우미'

/**
 * 파일 이름·번들 식별에 쓰는 ASCII 이름. `productName` 과 같아야 한다 —
 * 한글을 쓰면 헬퍼 번들이 "… 도우미 Helper.app" 이 되어 앱이 시작하자마자 죽는다.
 */
export const APP_NAME_ASCII = 'KNUAF-Dev'
