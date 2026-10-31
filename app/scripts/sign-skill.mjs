import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { sha256, jsonBytes, readTree, fileHashes, zipBytes, validVersion, MAX_BYTES, compose, overlayHash, writeTree } from './compose-skill.mjs'

export const RELEASE_PREFIX = 'https://github.com/knuaf-devcat/knuaf-dev/releases/download/'

export function signManifest(manifestBytes, privateKey) {
  let key
  try { key = createPrivateKey(privateKey) } catch { throw new Error('Invalid signing key (expected Ed25519 PKCS8 PEM)') }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519')
  return sign(null, manifestBytes, key).toString('base64')
}

// expectedFiles must be independently recomposed from trusted job inputs, not artifact checksums.
export function releaseManifest({ directory, archive, minApp, expectedFiles }) {
  if (!validVersion(minApp)) throw new Error('minApp must be safe-integer X.Y.Z')
  if (!(expectedFiles instanceof Map)) throw new Error('Independent composition is required')
  const files = readTree(directory)
  if (!jsonBytes(fileHashes(files)).equals(jsonBytes(fileHashes(expectedFiles)))) {
    throw new Error('Candidate files differ from independent composition')
  }
  const skill = JSON.parse(expectedFiles.get('skill.json')?.toString() ?? 'null')
  if (!skill || !validVersion(skill.version) || !Number.isSafeInteger(skill.api) || skill.api < 1) throw new Error('Invalid skill metadata')
  const zip = readFileSync(archive)
  if (!zip.equals(zipBytes(expectedFiles))) throw new Error('Archive bytes differ from independent composition')
  if (zip.length > MAX_BYTES) throw new Error('Archive exceeds download limit')
  return {
    schema: 1, name: 'knuaf-dev', version: skill.version, api: skill.api, minApp,
    url: `${RELEASE_PREFIX}skill-v${skill.version}/knuaf-dev-skill-${skill.version}.zip`,
    size: zip.length, sha256: sha256(zip), files: fileHashes(files)
  }
}

export function signedChannel(channel, manifestBytes, privateKey) {
  if (channel.schema !== 1) throw new Error('Unsupported channel schema')
  const { version, api, minApp, url } = JSON.parse(manifestBytes)
  return { ...channel, skill: { version, api, minApp, url,
    manifest: manifestBytes.toString('base64'), sig: signManifest(manifestBytes, privateKey) } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      directory: { type: 'string' }, zip: { type: 'string' }, 'min-app': { type: 'string', default: '0.6.0' },
      upstream: { type: 'string' }, source: { type: 'string' }, version: { type: 'string' },
      overlay: { type: 'string', default: resolve(import.meta.dirname, '../skill-overlay') },
      'expected-overlay': { type: 'string' },
      channel: { type: 'string', default: resolve(import.meta.dirname, '../../updates/channel.json') }, output: { type: 'string' }
    } })
    if (['directory', 'zip', 'output', 'upstream', 'source', 'version', 'expected-overlay'].some(k => !values[k])) {
      throw new Error('--directory, --zip, --output, --upstream, --source, --version and --expected-overlay are required')
    }
    // Only read source bytes; never install dependencies, import upstream modules or run its tests here.
    if (overlayHash(values.overlay) !== values['expected-overlay']) throw new Error('Trusted overlay hash mismatch')
    const expectedFiles = compose({
      upstream: values.upstream, source: JSON.parse(readFileSync(values.source, 'utf8')),
      overlay: values.overlay, version: values.version
    })
    const key = process.env.SKILL_SIGNING_PRIVATE_KEY
    if (!key) throw new Error('SKILL_SIGNING_PRIVATE_KEY is required')
    const bytes = jsonBytes(releaseManifest({
      directory: values.directory, archive: values.zip, minApp: values['min-app'], expectedFiles
    }))
    const channel = signedChannel(JSON.parse(readFileSync(values.channel, 'utf8')), bytes, key)
    mkdirSync(values.output, { recursive: true })
    writeFileSync(resolve(values.output, 'skill-manifest.json'), bytes)
    writeFileSync(resolve(values.output, 'skill-manifest.sig'), channel.skill.sig + '\n')
    writeFileSync(resolve(values.output, 'channel.json'), jsonBytes(channel))
    // Publish only these freshly recomposed bytes, never files read back from the test workspace.
    writeTree(expectedFiles, resolve(values.output, 'bundle'))
    const version = JSON.parse(expectedFiles.get('skill.json')).version
    writeFileSync(resolve(values.output, `knuaf-dev-skill-${version}.zip`), zipBytes(expectedFiles))
    console.log('Signed skill manifest; channel proposal written (not published)')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
