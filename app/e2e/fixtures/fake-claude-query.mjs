// Claude SDK의 초기화·대화 프로토콜만 흉내 낸다. 네트워크·실제 계정 접근 없음.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
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
      send({ type: 'assistant', uuid: 'answer', session_id: 'fake-session', message: {
        content: [{ type: 'text', text: '가짜 CLI 응답' }]
      } })
      send({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session' })
    }
  })
}
