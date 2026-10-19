/**
 * 정본 안의 상대경로를 절대경로로 — 결과물·미리보기가 쓰던 규칙 그대로다.
 * Windows 는 역슬래시다(원래 Artifacts 화면에 있던 판단을 한 곳으로 모았다).
 */
export function joinPath(root: string | null, rel: string): string {
  if (!root) return rel
  // POSIX 에서는 `rel` 을 **그대로** 이어 붙인다. 역슬래시는 여기서 평범한 파일명 글자라,
  // 구분자로 바꾸면 `build/probe\review.docx` 와 `build/probe/review.docx` 라는 **서로 다른
  // 두 파일**이 같은 열기 경로로 간다(검토 W1B-R1-01). 그래서 통일은 윈도우에서만 한다.
  if (window.knuaf.platform !== 'win32') return `${root}/${rel}`
  // 윈도우에서는 `/` 와 `\` 가 같은 구분자라, 정본의 `build/1/review/…` 를 `\` 로 통일해도
  // 파일이 달라지지 않는다 — 섞인 경로(`…\build/1/...`)를 만들지 않는다.
  return `${root}\\${rel.split(/[\\/]/).join('\\')}`
}
