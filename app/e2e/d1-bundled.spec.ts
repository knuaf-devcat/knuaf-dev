import { expect, test } from '@playwright/test'
import { mock } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { agentApi, bundledAgentDirs, bundledDirs, findExecutable, setAgentPlatformForTest } from '../src/main/agent'
import { ChatService } from '../src/main/chat/service'
import { ClaudeConnection } from '../src/main/chat/claude'
import { pathKeyOf } from '../src/main/chat/contracts'
import { agentActivity } from '../src/main/update/activity'

for (const platform of ['darwin', 'win32'] as const) for (const alsoOnPath of [false, true]) {
  test(`R8-01 ${platform}-${platform === 'win32' ? 'x64' : process.arch} packaged actual layout, competing PATH=${alsoOnPath}: all Claude consumers agree`, async () => {
    // Keep the fixture on cwd's drive so Darwin PATH can use a drive-free rooted
    // Windows path: a literal C: entry would be split at ':' by the simulated OS.
    const root = mkdtempSync(join(process.cwd(), '.knuaf-d1-')), resources = join(root, 'resources'), project = join(root, 'project'), skill = join(root, 'skill'), onPath = join(root, 'other-bin')
    const arch = platform === 'win32' ? 'x64' : process.arch
    const bundled = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`)
    mkdirSync(bundled, { recursive: true }); mkdirSync(project); mkdirSync(skill); mkdirSync(onPath)
    const name = platform === 'win32' ? 'claude.exe' : 'claude', binary = join(bundled, name), other = join(onPath, name)
    const pathEntry = process.platform === 'win32' && platform === 'darwin' ? onPath.replace(/^[A-Za-z]:/, '') : onPath
    writeFileSync(binary, 'fake bundled executable', { mode: 0o755 })
    if (alsoOnPath) writeFileSync(other, 'fake PATH executable', { mode: 0o755 })
    writeFileSync(join(skill, 'SKILL.md'), '# test')
    const env = { ...process.env }, resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath'), defaultDescriptor = Object.getOwnPropertyDescriptor(process, 'defaultApp')
    const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
    const previousPlatform = setAgentPlatformForTest(platform)
    const execCommands: string[] = [], spawnCommands: string[] = [], terminalScripts: string[] = []
    const childProcess = require('node:child_process')
    const exec = mock.method(childProcess, 'execFile', (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      execCommands.push(command); callback(null, args.includes('--version') ? '1.0.0-fake\n' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
    })
    const util = require('node:util'), originalPromisify = util.promisify
    const promisified = mock.method(util, 'promisify', (fn: unknown) => {
      if (fn !== childProcess.execFile) return originalPromisify(fn)
      return async (command: string) => {
        execCommands.push(command); return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' }
      }
    })
    const spawned = mock.method(childProcess, 'spawn', (command: string) => {
      spawnCommands.push(command)
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0) })
      return child
    })
    const turn = mock.method(ClaudeConnection.prototype, 'run', async () => {})
    const chat = new ChatService({ skillSource: () => skill, userData: join(root, 'userData'), emit: () => {}, openExternal: async () => {} })
    try {
      Object.defineProperty(process, 'arch', { value: arch, configurable: true })
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
      Object.defineProperty(process, 'defaultApp', { value: false, configurable: true })
      process.env[pathKeyOf(process.env)] = alsoOnPath ? pathEntry : ''
      process.env.HOME = root; process.env.USERPROFILE = root; delete process.env.KNUAF_AGENT_PATH_ONLY
      const ctx = { home: root, appRoot: join(root, 'app'), isPackaged: true, resourcesPath: resources, supportDir: join(root, 'launch'), dryRun: false, env: process.env, venvPython: () => null, open: async (path: string) => { terminalScripts.push(readFileSync(path, 'utf8')); return '' } }
      // Neither bundled provider nor directory calculation is replaced by a test stub.
      expect(bundledDirs(platform)).toEqual(bundledAgentDirs(ctx, platform))
      expect(findExecutable('claude')).toBe(binary)
      expect((await chat.status(project, 'claude')).connected).toBe(true)
      expect((await chat.globalStatus('claude')).connected).toBe(true)
      await chat.globalLogin('claude')
      await chat.globalStatus('claude')
      await chat.send(project, 'claude', 'fake turn', 'request-1'); await chat.stop(project, 'claude')
      expect(turn.mock.callCount()).toBe(1)
      expect((await agentApi.status(ctx, project)).claude.path).toBe(binary)
      await agentApi.launch(ctx, { root: project, kind: 'claude', revision: null })
      expect(execCommands.every(path => path === binary)).toBe(true)
      expect(spawnCommands).toEqual([binary])
      expect(terminalScripts).toHaveLength(1)
      expect(terminalScripts[0]).toContain(binary)
      expect(terminalScripts[0]).not.toContain(other)
      process.env.KNUAF_AGENT_PATH_ONLY = '1'
      const pathOnly = findExecutable('claude'), statusPath = (await agentApi.status(ctx, project)).claude.path
      expect(pathOnly && resolve(pathOnly)).toBe(alsoOnPath ? other : null)
      expect(statusPath && resolve(statusPath)).toBe(alsoOnPath ? other : null)
    } finally {
      await chat.close()
      exec.mock.restore(); spawned.mock.restore(); turn.mock.restore(); promisified.mock.restore(); agentActivity.resume()
      setAgentPlatformForTest(previousPlatform)
      if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor); else Reflect.deleteProperty(process, 'resourcesPath')
      if (defaultDescriptor) Object.defineProperty(process, 'defaultApp', defaultDescriptor); else Reflect.deleteProperty(process, 'defaultApp')
      Object.defineProperty(process, 'arch', archDescriptor)
      for (const key of Object.keys(process.env)) delete process.env[key]
      for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value
      rmSync(root, { recursive: true, force: true })
    }
  })
}
