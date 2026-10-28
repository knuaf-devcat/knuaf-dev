import { useRef, useState } from 'react'
import type { ParsedForm } from '../../../shared/question-form'
import { QUESTION_FORM } from '../copy'

interface Props {
  form: ParsedForm
  onFree: () => void
  onSend: (text?: string) => Promise<boolean>
  disabled: boolean
}

export function QuestionForm({ form, onFree, onSend, disabled }: Props) {
  const [values, setValues] = useState(() => form.fields.map(() => ''))
  const [unknown, setUnknown] = useState(() => form.fields.map(() => false))
  const [sending, setSending] = useState(false)
  const locked = useRef(false)
  const answers = form.fields.map((field, i) => `${i + 1}. ${field.label}: ${unknown[i] ? QUESTION_FORM.undecided : values[i].trim()}`)
  const complete = values.every((value, i) => unknown[i] || value.trim())
  const submit = async (text?: string) => {
    if (locked.current || disabled) return
    locked.current = true
    setSending(true)
    try { await onSend(text) } finally { locked.current = false; setSending(false) }
  }
  return <form className="qform" onSubmit={(event) => { event.preventDefault(); if (complete) void submit(answers.join('\n')) }}>
    <div className="qform-head"><strong>{form.title}</strong><span>{values.filter((v, i) => unknown[i] || v.trim()).length} / {values.length} {QUESTION_FORM.filled}</span></div>
    <div className="qform-fields">{form.fields.map((field, i) => <div className="qform-field" key={i}>
      <label htmlFor={`qform-${i}`}><strong>{i + 1}. {field.label}</strong> {field.description && <span>{field.description}</span>}</label>
      {field.notes.map((note, n) => <div className="qform-note" key={n}>{note}</div>)}
      <div className="qform-row"><input id={`qform-${i}`} value={values[i]} disabled={unknown[i]} placeholder={field.example} onChange={(e) => setValues(values.map((v, n) => n === i ? e.target.value : v))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.nativeEvent.isComposing) { e.preventDefault(); return }
          if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
          const inputs = Array.from(e.currentTarget.form?.querySelectorAll<HTMLInputElement>('input:not(:disabled)') ?? [])
          const next = inputs[inputs.indexOf(e.currentTarget) + 1]
          if (next) { e.preventDefault(); next.focus() }
        }} />
        <button type="button" aria-pressed={unknown[i]} onClick={() => setUnknown(unknown.map((v, n) => n === i ? !v : v))}>{QUESTION_FORM.undecided}</button></div>
      {unknown[i] && field.undecided && <div className="qform-note">{field.undecided}</div>}
    </div>)}</div>
    <div className="qform-preview"><strong>{QUESTION_FORM.preview}</strong>{answers.map((answer, i) => <div key={i}>{answer || ''}{!unknown[i] && !values[i].trim() ? QUESTION_FORM.empty : ''}</div>)}</div>
    <div className="qform-foot"><button type="button" onClick={onFree}>{QUESTION_FORM.free}</button><span>{QUESTION_FORM.keys}</span><button type="submit" className="primary" disabled={!complete || disabled || sending}>{QUESTION_FORM.send}</button></div>
  </form>
}
