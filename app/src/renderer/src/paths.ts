/**
 * 정본 안의 상대경로를 절대경로로 — 결과물·미리보기가 쓰던 규칙 그대로다.
 * Windows 는 역슬래시다(원래 Artifacts 화면에 있던 판단을 한 곳으로 모았다).
 */
export function joinPath(root: string | null, rel: string): string {
  if (!root) return rel
  return `${root}${window.knuaf.platform === 'win32' ? '\\' : '/'}${rel}`
}
