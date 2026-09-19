import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT } from './python'
import { loadSettings } from './settings'

export type MenuAction =
  | { type: 'open-folder' }
  | { type: 'open-recent'; root: string }
  | { type: 'refresh' }
  | { type: 'screen'; screen: string }
  | { type: 'settings' }
  | { type: 'ai-helper' }

const SCREENS: [string, string][] = [['home', '홈'], ['chat', '내 논문'], ['materials', '자료'], ['artifacts', '결과물'], ['dashboard', '대시보드'], ['checks', '검사 결과'], ['tasks', '다음 할 일'], ['sections', '절 목록'], ['outputs', '도구'], ['troubleshoot', '문제 해결'], ['settings', '설정']]

/** docs/ lives next to app/ in a checkout and under Resources/docs when packaged. */
export function docsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'docs') : join(APP_ROOT, '..', 'docs')
}
export function guidePath(kind: 'pdf' | 'html' | 'md'): string | null {
  const p = join(docsDir(), `학생용-사용안내.${kind}`)
  return existsSync(p) ? p : null
}

export function openGuide(): void {
  const p = guidePath('pdf') ?? guidePath('html') ?? guidePath('md')
  if (p) void shell.openPath(p)
}

/** Korean menu bar. The Edit menu is what makes ⌘C/⌘V work inside inputs. */
export function installMenu(send: (a: MenuAction) => void): void {
  const isMac = process.platform === 'darwin'
  const recent = loadSettings().recent
  const recentItems: MenuItemConstructorOptions[] = recent.length
    ? recent.map((r) => ({ label: r.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r.root, sublabel: r.root, click: () => send({ type: 'open-recent', root: r.root }) }))
    : [{ label: '최근 폴더 없음', enabled: false }]
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'knuaf-doc 동반 앱 정보', role: 'about' as const },
        { type: 'separator' as const },
        { label: '설정…', accelerator: 'CmdOrCtrl+,', click: () => send({ type: 'settings' }) },
        { type: 'separator' as const },
        { role: 'services' as const, label: '서비스' },
        { type: 'separator' as const },
        { role: 'hide' as const, label: '가리기' },
        { role: 'hideOthers' as const, label: '다른 앱 가리기' },
        { role: 'unhide' as const, label: '모두 보기' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: '종료' }
      ]
    }] : []),
    {
      label: '파일',
      submenu: [
        { label: '폴더 열기…', accelerator: 'CmdOrCtrl+O', click: () => send({ type: 'open-folder' }) },
        { label: '최근 폴더', submenu: recentItems },
        { type: 'separator' },
        { label: 'AI 도우미 열기', accelerator: 'CmdOrCtrl+Shift+A', click: () => send({ type: 'ai-helper' }) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' }
      ]
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '실행 복귀' }, { type: 'separator' },
        { role: 'cut', label: '오려두기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '모두 선택' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: () => send({ type: 'refresh' }) },
        { type: 'separator' },
        ...SCREENS.map(([id, label], i) => ({ label, ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}), click: () => send({ type: 'screen', screen: id }) })),
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
        ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const, label: '개발자 도구' }])
      ]
    },
    {
      label: '창',
      role: 'window',
      submenu: [{ role: 'minimize', label: '최소화' }, { role: 'zoom', label: '확대/축소' }, ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const, label: '모두 앞으로' }] : [])]
    },
    {
      label: '도움말',
      role: 'help',
      submenu: [
        { label: '사용 안내 (PDF)', click: openGuide },
        { label: '로그 폴더 열기', click: () => void shell.openPath(app.getPath('logs')) },
        { label: '작업 폴더를 Finder에서 보기', click: () => { const w = BrowserWindow.getFocusedWindow(); const f = w?.getRepresentedFilename(); if (f) shell.showItemInFolder(f) } }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (isMac) {
    app.dock?.setMenu(Menu.buildFromTemplate(recent.length ? recent.map((r) => ({ label: r.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r.root, click: () => send({ type: 'open-recent', root: r.root }) })) : [{ label: '최근 폴더 없음', enabled: false }]))
  }
}
