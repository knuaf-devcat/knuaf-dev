// Claude SDK의 초기화·대화 프로토콜만 흉내 낸다. 네트워크·실제 계정 접근 없음.
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
} else if (args[0] === 'auth' && args[1] === 'login') {
  appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify({ args }) + '\n')
  console.log('https://example.invalid/fake-claude-login')
  const timer = setInterval(() => {
    if (!existsSync(process.env.W1_LOGIN_COMPLETE)) return
    clearInterval(timer)
    if (process.env.W1_LOGIN_FAIL === '1') process.exitCode = 1
    else writeFileSync(process.env.W1_AUTH_STATE, 'fake login completed')
  }, 20)
} else {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\n')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    appendFileSync(process.env.W1_QUERY_LOG, JSON.stringify(msg) + '\n')
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      // 소비하지 않는 stderr 파이프가 대화를 멈추는 회귀도 잡는다.
      process.stderr.write('x'.repeat(256 * 1024), () => send({ type: 'control_response', response: {
        subtype: 'success', request_id: msg.request_id,
        response: { commands: [{ name: 'knuaf-dev' }], account: { apiKeySource: 'none' } }
      } }))
    } else if (msg.type === 'user') {
      const failure = process.env.W1_QUERY_ERROR || (process.env.W1_AUTH_STATE && !existsSync(process.env.W1_AUTH_STATE) ? 'authentication_failed' : '')
      if (failure) {
        const text = failure === 'authentication_failed'
          ? 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.'
          : failure === 'rate_limit' ? 'API Error: 429 rate limit exceeded' : 'Network error: ECONNRESET'
        send({ type: 'assistant', error: failure === 'network' ? 'unknown' : failure, uuid: 'fake-error', session_id: 'fake-session', message: {
          content: [{ type: 'text', text }]
        } })
        send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text], session_id: 'fake-session' })
        return
      }
      send({ type: 'assistant', uuid: 'answer', session_id: 'fake-session', message: {
        content: [{ type: 'text', text: '가짜 CLI 응답' }]
      } })
      send({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session' })
    }
  })
}
