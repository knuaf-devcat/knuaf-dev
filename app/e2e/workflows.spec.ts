// 워크플로 설정 시험 — 브랜치 수동 실행이 서명·공증 자격에 닿지 않음을 고정한다(검토 W2-R1-01).
//
// 정적 검토는 "지금 이 파일에 그 경로가 없다"까지만 말한다. 여기서는 그 사실을 시험으로 못
// 박아 둔다 — 나중에 `release.yml` 에 `workflow_dispatch` 를 다시 붙이거나, 설치본 확인용
// 워크플로에 비밀값·서명 설정을 넘기면 CI 가 먼저 깨진다.
//
// YAML 라이브러리를 새로 들이지 않는다(의존성 추가 금지). 트리거 블록과 문자열만 본다.
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WORKFLOWS = resolve(__dirname, '..', '..', '.github', 'workflows')
const read = (name: string) => readFileSync(resolve(WORKFLOWS, name), 'utf8')

/** `on:` 블록(다음 최상위 키 전까지)만 뽑는다. */
function triggers(yaml: string): string {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => /^on:/.test(l))
  expect(start, 'on: 블록이 없다').toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.trim() !== '' && !/^\s/.test(l))
  return rest.slice(0, end === -1 ? undefined : end).join('\n')
}

/** `on:` 안의 특정 트리거 블록만 뽑는다(그 다음 트리거 전까지). */
function triggerBlock(yaml: string, name: string): string {
  const lines = triggers(yaml).split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s{2}${name}:`).test(l))
  expect(start, `${name}: 블록이 없다`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\s{2}\S/.test(l))
  return rest.slice(0, end === -1 ? undefined : end).join('\n')
}

test('release.yml 은 태그 배포 전용이다 — 브랜치 수동 실행 경로가 없다 (W2-R1-01)', () => {
  const yaml = read('release.yml')
  const on = triggers(yaml)
  expect(on).toMatch(/tags:\s*\[\s*"v\*"\s*\]/)
  // 이 워크플로는 서명·공증 자격을 export 하므로, 브랜치에서 손으로 돌릴 수 있으면 안 된다.
  expect(on, 'release.yml 에 workflow_dispatch 가 다시 붙었다').not.toMatch(/workflow_dispatch/)
  expect(yaml, '태그 배포 경로의 서명 자격 주입이 사라졌다').toMatch(/secrets\.CSC_LINK/)
})

test('build-installers.yml 은 설치본에 영향 주는 feat/** push 와 수동 실행에서만 돈다 (W2-R1-01)', () => {
  const raw = read('build-installers.yml')
  // 주석은 설정이 아니므로 뺀다 — 이 파일은 주석에서 `secrets` 를 언급한다.
  const yaml = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  const on = triggers(raw)
  expect(on).toMatch(/workflow_dispatch/)
  expect(on, '태그로도 돈다 — 배포 경로와 겹친다').not.toMatch(/tags:/)
  // push 는 feat/** 로만, 설치본에 영향을 주는 파일에서만 돈다.
  const push = triggerBlock(raw, 'push')
  expect(push).toMatch(/branches:\s*\[\s*"feat\/\*\*"\s*\]/)
  for (const glob of [
    // 설치본에 들어가는 입력 전체를 덮는 단순한 목록(W2-ENC-R1-02). 쪼개면 빠뜨리는 구멍이
    // 생긴다 — `app/**` 가 app/src·app/sidecar·electron.vite.config.ts 를 모두 포함한다.
    'app/**',
    'skills/knuaf-dev/**',
    'docs/학생용-사용안내.*',
    '.github/workflows/build-installers.yml',
    '.github/workflows/release.yml',
  ]) {
    expect(push, `paths 에 ${glob} 가 없다`).toContain(glob)
  }
  expect(push.split('\n').filter((l) => /^\s{6}- "/.test(l)), 'paths 항목 수가 바뀌었다').toHaveLength(5)
  // 비밀값: 참조 자체가 없어야 한다(`secrets: inherit` 포함).
  expect(yaml, '비밀값을 참조한다').not.toMatch(/secrets/)
  // 서명·공증: 자동 탐색을 끄고 공증을 명시적으로 끈다.
  expect(yaml).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/)
  expect(yaml).toMatch(/--config\.mac\.notarize=false/)
  // 발행: 권한은 읽기뿐이고, publish 도 꺼져 있으며, Release 를 만지는 명령이 없다.
  expect(yaml).toMatch(/permissions:\s*\n\s*contents:\s*read/)
  expect(yaml).toMatch(/--publish never/)
  expect(yaml, 'Release 자산을 만질 수 있는 명령이 있다').not.toMatch(/gh release|softprops|actions\/create-release/)
})

test('설치본 체크섬은 OS별로 나뉘어 서로 덮어쓰지 않는다 (W2-R1-02)', () => {
  const yaml = read('release.yml')
  expect(yaml).toMatch(/SHA256SUMS-macos\.txt/)
  expect(yaml).toMatch(/SHA256SUMS-windows\.txt/)
  // 예전 이름으로 올리면 맥 체크섬을 윈도우가 덮어쓴다.
  expect(yaml, '동명 체크섬 파일을 쓴다').not.toMatch(/SHA256SUMS\.txt/)
  // 릴리스 본문 안내도 두 이름을 모두 가리켜야 한다.
  expect(yaml).toMatch(/SHA256SUMS-macos\.txt\\`\(macOS\)/)
})
