// Copy the skill scripts (and the reference docs the GUI links to) into resources/skill for packaging.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const app = resolve(import.meta.dirname, '..')
const src = resolve(app, '..', 'skills', 'knuaf-dev')
const dst = resolve(app, 'resources', 'skill')
if (!existsSync(resolve(src, 'scripts', 'gg_core.py'))) { console.error('skill scripts not found at', src); process.exit(1) }
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
cpSync(resolve(src, 'scripts'), resolve(dst, 'scripts'), { recursive: true, filter: (p) => !p.includes('__pycache__') })
cpSync(resolve(src, 'SKILL.md'), resolve(dst, 'SKILL.md'))
cpSync(resolve(src, 'references'), resolve(dst, 'references'), { recursive: true })
console.log('staged skill →', dst)
