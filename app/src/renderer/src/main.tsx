import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const k = (window as unknown as { knuaf?: { platform?: string; windowInfo?: () => Promise<{ vibrancy: boolean }> } }).knuaf
document.documentElement.dataset.platform = k?.platform ?? 'darwin'
document.documentElement.dataset.vibrancy = 'off'
void k?.windowInfo?.().then((info) => { document.documentElement.dataset.vibrancy = info?.vibrancy ? 'on' : 'off' })

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
