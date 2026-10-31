import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolved with git ls-remote and confirmed through each repository's Git commit API.
// Changing a pin requires reviewing the upstream commit and changing this allowlist too.
export const ACTION_COMMITS = Object.freeze({
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262', // v4
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020', // v4
  'actions/setup-python': 'a26af69be951a213d495a4c3e4e4022e16d87065', // v5
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02', // v4
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093', // v4
  'peter-evans/create-pull-request': '22a9089034f40e5a961c8808d113e2c98fb63676' // v7
})

export function checkWorkflowPins(text) {
  const refs = []
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*#/.test(line) || !/["']?uses["']?\s*:/.test(line)) continue
    // This workflow's policy requires a literal, single-line uses key, not YAML aliases/folding.
    const match = /^\s*(?:-\s+)?uses:\s*([\w-]+\/[\w.-]+)@([a-f0-9]{40})\s*(?:#.*)?$/.exec(line)
    if (!match || ACTION_COMMITS[match[1]] !== match[2]) {
      throw new Error(`Unreviewed or mutable action reference at line ${index + 1}`)
    }
    refs.push(`${match[1]}@${match[2]}`)
  }
  if (!refs.length) throw new Error('No pinned action references found')
  return refs
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2] ?? resolve(import.meta.dirname, '../../../.github/workflows/skill-release.yml')
    console.log(`Checked ${checkWorkflowPins(readFileSync(path, 'utf8')).length} immutable action references`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
