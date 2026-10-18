/**
 * 정본 안의 상대경로를 절대경로로 — 결과물·미리보기가 쓰던 규칙 그대로다.
 * Windows 는 역슬래시다(원래 Artifacts 화면에 있던 판단을 한 곳으로 모았다).
 */
export function joinPath(root: string | null, rel: string): string {
  if (!root) return rel
  const sep = window.knuaf.platform === 'win32' ? '\\' : '/'
  // `rel` 은 정본이 담은 상대경로라 `build/1/review/…` 처럼 슬래시로 온다 — 구분자를
  // 끼워 넣기만 하면 윈도우에서 `…\build/1/...` 처럼 섞인다(사용자에게 보이는 경로).
  return `${root}${sep}${rel.split(/[\\/]/).join(sep)}`
}
