import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  // node-pty is a native N-API module: it must load from node_modules, not the bundle.
  main: { build: { outDir: 'out/main', rollupOptions: { external: ['node-pty'] } } },
  preload: { build: { outDir: 'out/preload' } },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { outDir: resolve(__dirname, 'out/renderer'), rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [react()]
  }
})
