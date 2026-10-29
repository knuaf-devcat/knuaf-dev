export interface FormField {
  label: string
  description: string
  example: string
  undecided: string
  notes: string[]
}

export interface ParsedForm { title: string; fields: FormField[] }

/** 질문 원문을 유지하며, 확실하게 분리되는 여러 칸만 해석한다. */
export function parseQuestionForm(text: string): ParsedForm | null {
  const lines = text.split(/\r?\n/)
  let header = -1
  let title = ''
  let id = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].replace(/\*\*|__/g, '').match(/^\s*\[Q(\d+(?:-\d+)?)\]\s*(\S.*)$/)
    if (match) { header = i; id = match[1]; title = match[2].trim(); break }
  }
  if (header < 0) return null
  // 별도 금액 질문은 여러 칸이 아니라 일반 입력으로 받는다.
  if (id !== '2' && /자금|금액/.test(title) && /얼마/.test(title)) return null
  const fields: FormField[] = []
  let ended = false
  let afterUndecided = false
  for (const line of lines.slice(header + 1)) {
    if (!line.trim()) continue
    const numbered = line.match(/^\s*(\d+)([.)])\s*(.*)$/)
    if (numbered) {
      if (ended || numbered[2] !== '.' || Number(numbered[1]) !== fields.length + 1 || fields.length === 6) return null
      const label = numbered[3].replace(/\*\*|__/g, '').match(/^([^()]+?)(?:\s*\(([^()]*)\)|:\s+(.+))?\s*$/)
      if (!label || !label[1].trim()) return null
      fields.push({ label: label[1].trim(), description: (label[2] ?? label[3])?.trim() ?? '', example: '', undecided: '', notes: [] })
      afterUndecided = false
      continue
    }
    if (/^\s*\[Q\d/.test(line)) return null
    if (!fields.length) continue
    if (!/^\s/.test(line)) { ended = true; continue }
    if (ended) continue
    const field = fields[fields.length - 1]
    const content = line.trim()
    if (content.startsWith('예:')) {
      if (!field.example) field.example = content
      else field.notes.push(content)
      afterUndecided = false
    } else if (content.startsWith('미정이면:')) {
      if (field.undecided) return null
      field.undecided = content.slice('미정이면:'.length).trim()
      afterUndecided = true
    } else if (afterUndecided && /^\(.*\)$/.test(content)) {
      field.undecided += ` ${content}`
      afterUndecided = false
    } else {
      field.notes.push(content)
      afterUndecided = false
    }
  }
  return fields.length >= 2 ? { title, fields } : null
}
