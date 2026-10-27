import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const now = new Date()
const buildDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
let buildCommit = 'unknown'
try {
  buildCommit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'
} catch { /* 소스 압축본 등 git 저장소가 없는 빌드는 unknown 으로 표시한다 */ }

export default defineConfig({
  // node-pty is a native N-API module: it must load from node_modules, not the bundle.
  main: {
    define: { __APP_BUILD_DATE__: JSON.stringify(buildDate), __APP_BUILD_COMMIT__: JSON.stringify(buildCommit) },
    build: { outDir: 'out/main', rollupOptions: { external: ['node-pty'] } }
  },
  preload: { build: { outDir: 'out/preload' } },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { outDir: resolve(__dirname, 'out/renderer'), rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()]
  }
})
