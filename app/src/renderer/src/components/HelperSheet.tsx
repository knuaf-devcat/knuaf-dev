import { useProject } from '../store/project'
import { Sheet } from './Sheet'
import { Feedback } from './Feedback'
import { Badge } from './Badge'
import { HELPER } from '../copy'
import { useShallow } from 'zustand/react/shallow'

/** "AI 도우미 열기": detect Claude Code / Codex, install the skill, open a Terminal session. */
export function HelperSheet() {
  const { helper, closeHelper, launchHelper } = useProject(useShallow((s) => ({ helper: s.helper, closeHelper: s.closeHelper, launchHelper: s.launchHelper })))
  const st = helper.status
  const none = st && !st.claude.found && !st.codex.found
  const both = st && st.claude.found && st.codex.found
  return (
    <Sheet open={helper.open} title={HELPER.button} onClose={closeHelper} foot={<button onClick={closeHelper}>닫기</button>}>
      {!st && !helper.error && <p className="muted">도우미를 찾는 중…</p>}
      {helper.error && <Feedback kind={helper.error.kind} title={helper.error.title} body={helper.error.action} details={<code>{helper.error.raw}</code>} />}
      {none && (
        <Feedback kind="warning" title={HELPER.notInstalledTitle} body={HELPER.notInstalledBody} actions={<button className="primary" onClick={() => window.knuaf.openGuide()}>{HELPER.installGuide}</button>} />
      )}
      {st && !none && !helper.result && (
        <div className="stack">
          {both && <p>{HELPER.chooseBody}</p>}
          <div className="row">
            {st.claude.found && <button className="primary" onClick={() => launchHelper('claude')}>Claude Code 열기 <Badge label={st.claude.version ?? ''} /></button>}
            {st.codex.found && <button onClick={() => launchHelper('codex')}>Codex 열기 <Badge label={st.codex.version ?? ''} /></button>}
          </div>
          <p className="caption">규칙집 상태 — Claude: {st.skill.claude === 'installed' ? '최신' : st.skill.claude === 'outdated' ? '갱신 예정' : '설치 예정'}{st.codex.found ? ` · Codex: ${st.skill.codex === 'installed' ? '최신' : st.skill.codex === 'outdated' ? '갱신 예정' : '설치 예정'}` : ''}</p>
        </div>
      )}
      {helper.result && <Feedback kind="completion" title={HELPER.launchedTitle} body={HELPER.launchedBody} />}
    </Sheet>
  )
}
