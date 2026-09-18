import type { Envelope } from '../../../shared/types'

/** Shows a normalised script result: status, path (with reveal), block reason, raw JSON. */
export function EnvelopeView({ env, onReveal }: { env: Envelope; onReveal?: (path: string) => void }) {
  return (
    <div className={'banner ' + (env.ok ? 'info' : 'bad')}>
      <div className="row">
        <strong>{env.ok ? '완료' : '실패'}</strong>
        {env.status && <span className="pill">{env.status}</span>}
        <span className="muted">{env.duration_ms} ms · exit {env.exit}</span>
      </div>
      {env.block_reason && <div>사유: {env.block_reason}</div>}
      {env.path && (
        <div className="row"><code>{env.path}</code>{onReveal && <button onClick={() => onReveal(env.path!)}>폴더에서 보기</button>}</div>
      )}
      {env.data != null && <details><summary>자세히</summary><pre>{JSON.stringify(env.data, null, 2)}</pre></details>}
      {!env.ok && env.stderr && <details><summary>오류 출력</summary><pre>{env.stderr}</pre></details>}
    </div>
  )
}
