#!/usr/bin/env node
/**
 * 多窗口端到端测试：tab 分离（detach）/ 合并（attach）/ 空独立窗口关闭
 *
 * 在测试脚本内模拟主进程 WindowManager 的 IPC（window:register / tabs:changed /
 * tab:drop / tab:attach / tab:detach），用真实 renderer + preload 验证：
 * 1. 主窗口打开 VNC tab
 * 2. 纵向拖拽 → dropTab 返回 detach → 创建独立窗口并接管会话（主窗口 tab 移除）
 * 3. 独立窗口纵向拖拽 → dropTab 返回 attach(主窗口) → 会话移交主窗口，
 *    独立窗口因无 tab 自动关闭，主窗口 tab 恢复
 */
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

// ---------- 简化 WindowManager（模拟主进程） ----------
const records = new Map()
let mainId = null
let dropAction = 'detach'
let attachTarget = null

function createWindow(opts = {}) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const wcId = win.webContents.id
  if (mainId === null) mainId = wcId
  records.set(wcId, { win, tabs: [], isMain: wcId === mainId, hadTabs: false })
  win.webContents.on('did-finish-load', () => {
    if (opts.profile && opts.sessionId) {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.send('window:init-profile', opts.profile, opts.sessionId)
        }
      }, 300)
    }
  })
  win.on('closed', () => records.delete(wcId))
  win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  return win
}

// ---------- IPC：会话 / 配置 桩 ----------
let sessionCounter = 0
const sessionInfos = []
const PROFILE = {
  id: 'p1',
  name: 'VNC测试',
  protocol: 'vnc',
  vnc: { host: '127.0.0.1', port: 5999, password: '', viewOnly: false, scaleView: true, quality: 6, scaleMode: 'fill' },
  createdAt: 0
}

ipcMain.handle('session:create', (_e, profile) => {
  const sessionId = 'mw-' + ++sessionCounter
  const info = { sessionId, profileId: 'x', name: profile.name, protocol: profile.protocol, status: 'connected', message: undefined }
  sessionInfos.push(info)
  return info
})
ipcMain.handle('session:list', () => sessionInfos)
ipcMain.handle('session:close', () => {})
ipcMain.handle('profiles:list', () => [PROFILE])
ipcMain.handle('profiles:save', () => ({ id: 'x' }))
ipcMain.handle('profiles:update', () => ({}))
ipcMain.handle('profiles:delete', () => true)
ipcMain.handle('vnc:endpoint', () => null)
ipcMain.handle('clipboard:read', () => '')
ipcMain.handle('clipboard:write', () => {})
ipcMain.handle('rdp:detect', () => ({ available: false }))
ipcMain.handle('serial:list', () => [])
ipcMain.handle('dialog:selectFile', () => null)

// ---------- IPC：多窗口 ----------
ipcMain.on('window:register', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const wcId = win.webContents.id
  if (mainId === null) mainId = wcId
  records.set(wcId, { win, tabs: [], isMain: wcId === mainId, hadTabs: false })
})
ipcMain.on('tabs:changed', (e, tabs) => {
  const wcId = e.sender.id
  const rec = records.get(wcId)
  if (rec) {
    rec.tabs = tabs
    if (tabs.length > 0) rec.hadTabs = true
    if (!rec.isMain && rec.hadTabs && tabs.length === 0 && !rec.win.isDestroyed()) {
      rec.win.close()
    }
  }
})
ipcMain.handle('tab:drop', () => {
  if (dropAction === 'detach') return { action: 'detach' }
  return { action: 'attach', targetWindowId: attachTarget }
})
ipcMain.handle('tab:attach', (_e, { profile, sessionId, targetWindowId }) => {
  const rec = records.get(targetWindowId)
  if (rec && !rec.win.isDestroyed()) {
    rec.win.webContents.send('window:attach-tab', profile, sessionId)
  }
})
ipcMain.handle('tab:detach', (_e, { profile, sessionId }) => {
  createWindow({ profile, sessionId })
})

// ---------- 测试流程 ----------
const readTabCount = (win) =>
  win.webContents.executeJavaScript(`document.querySelectorAll('.tabs .tab').length`)

const vDrag = (win) =>
  win.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('.tabs .tab:not(.tab-home)')
    if (!tab) return 'NO_TAB'
    const r = tab.getBoundingClientRect()
    const fire = (type, y) => tab.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
      clientX: r.left + 50, clientY: y, button: 0,
      buttons: type === 'pointerup' ? 0 : 1
    }))
    fire('pointerdown', r.top + 10)
    fire('pointermove', r.top + 130)
    fire('pointerup', r.top + 130)
    return 'V_DRAG'
  })()`)

app.whenReady().then(async () => {
  // 主窗口
  const mainWin = createWindow()
  await new Promise((r) => setTimeout(r, 1500))

  // 双击首页 VNC 配置，打开一个 tab
  await mainWin.webContents
    .executeJavaScript(`(() => {
      const item = document.querySelector('.grid-col .profile-item') || document.querySelector('.profile-item')
      if (!item) return 'NO_ITEM'
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return 'DBL'
    })()`)
    .then((r) => console.log('[test] open vnc:', r))
  await new Promise((r) => setTimeout(r, 1000))
  console.log('[test] main tabs before detach:', await readTabCount(mainWin))

  // ---- 1) detach：主窗口纵向拖拽 → 独立新窗口 ----
  dropAction = 'detach'
  console.log('[test] detach drag:', await vDrag(mainWin))
  await new Promise((r) => setTimeout(r, 2500)) // 新窗口创建 + 接管会话
  const detachedWin = [...records.values()].find((r) => !r.isMain)?.win
  console.log('[test] detached window exists:', !!detachedWin)
  if (detachedWin) {
    console.log('[test] detached tabs:', await readTabCount(detachedWin))
  }
  console.log('[test] main tabs after detach:', await readTabCount(mainWin))

  // ---- 2) attach：独立窗口纵向拖拽 → 合并回主窗口 ----
  if (detachedWin) {
    dropAction = 'attach'
    attachTarget = mainId
    console.log('[test] attach drag:', await vDrag(detachedWin))
    await new Promise((r) => setTimeout(r, 2500)) // 主窗口接管 + 独立窗口关闭
    console.log('[test] detached window closed:', detachedWin.isDestroyed())
    console.log('[test] main tabs after attach:', await readTabCount(mainWin))
  }

  app.exit(0)
})
