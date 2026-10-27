/** 첫 메시지에서 파일 시스템에 쓸 수 있는 논문 폴더 이름을 만든다. */
export function projectFolderName(text: string): string {
  const firstLine = text.split(/[\r\n]/, 1)[0] ?? ''
  const cleaned = firstLine.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  const encoder = new TextEncoder()
  let name = ''
  let bytes = 0
  for (const char of Array.from(cleaned).slice(0, 60)) {
    bytes += encoder.encode(char.normalize('NFD')).length
    if (bytes > 200) break
    name += char
  }
  name = name.replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..') name = '새 논문'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `논문 ${name}`
  return name
}
