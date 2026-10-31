import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractSkill } from '../src/main/update/archive'
import { sha256, verifySkill } from '../src/main/update/manifest'

// Single source owned by W2. Missing fixture is a failure, never a skipped contract.
test('W2 original-byte signature and ZIP pass W1; the shared one-byte mutation fails', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../scripts/tests/fixtures/skill-signature-vector.json'), 'utf8'))
  const proof = verifySkill(vector, [vector.publicKey])
  const archive = Buffer.from(vector.archive, 'base64')
  expect(sha256(archive)).toBe(proof.manifest.sha256)
  expect(archive.length).toBe(proof.manifest.size)
  const root = mkdtempSync(join(tmpdir(), 'knuaf-shared-vector-'))
  try {
    extractSkill(archive, root, proof.manifest)
    for (const [name, hash] of Object.entries(proof.manifest.files)) expect(sha256(readFileSync(join(root, name)))).toBe(hash)
  } finally { rmSync(root, { recursive: true, force: true }) }
  const mutated = Buffer.from(vector.manifest, 'base64')
  mutated[vector.mutation.offset] ^= vector.mutation.xor
  expect(() => verifySkill({ ...vector, manifest: mutated.toString('base64') }, [vector.publicKey])).toThrow(/서명/)
})
