#!/usr/bin/env node
/**
 * 验证新布局：首页类别网格 + 双击打开 tab + 标签栏「+」弹出选择框。
 * 运行：先 npm run build，再 npx electron scripts/test-layout.cjs
 */
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

app.whenReady().then(async () => {
  ipcMain.handle('profiles:list', () => [
    {
      id: '1', name: 'SSH服务器', protocol: 'ssh',
      ssh: { host: '1.2.3.4', port: 22, username: 'root', authType: 'password', password: '', privateKeyPath: '', passphrase: '' }, createdAt: 0
    },
    {
      id: '2', name: '串口设备', protocol: 'serial',
      serial: { path: 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }, createdAt: 0
    },
    {
      id: '3', name: 'VNC桌面', protocol: 'vnc',
      vnc: { host: '1.2.3.4', port: 5900, password: '', viewOnly: false, scaleView: true, quality: 6 }, createdAt: 0
    },
    {
      id: '4', name: 'RDP机器', protocol: 'rdp',
      rdp: { host: '1.2.3.4', port: 3389, username: '', password: '', domain: '', resolution: '1280x800' }, createdAt: 0
    }
  ])
  ipcMain.handle('rdp:detect', () => ({ available: true }))
  ipcMain.handle('serial:list', () => [])
  ipcMain.handle('session:create', () => ({ sessionId: 's1', profileId: '1', name: 'SSH服务器', protocol: 'ssh', status: 'connecting' }))
  ipcMain.handle('session:close', () => {})
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('vnc:endpoint', () => null)
  ipcMain.handle('dialog:selectFile', () => null)
  ipcMain.handle('clipboard:read', () => '')
  ipcMain.handle('clipboard:write', () => {})
  ipcMain.handle('profiles:save', () => ({}))
  ipcMain.handle('profiles:update', () => ({}))
  ipcMain.handle('profiles:delete', () => true)

  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1500))

  const home = await win.webContents.executeJavaScript(
    `(() => ({
      grid: !!document.querySelector('.grid-view'),
      cols: document.querySelectorAll('.grid-col').length,
      items: document.querySelectorAll('.grid-col .profile-item').length,
      tabAdd: !!document.querySelector('.tab-add'),
      homeTab: !!document.querySelector('.tab-home'),
      homeActive: document.querySelector('.tab-home')?.classList.contains('active'),
      homeClose: !!document.querySelector('.tab-home .tab-close'),
      homeDraggable: document.querySelector('.tab-home')?.getAttribute('draggable'),
      homeTitle: !!document.querySelector('.tab-home .tab-title')
    }))()`
  )
  console.log('[test] HOME:', JSON.stringify(home))

  await win.webContents.executeJavaScript(
    `(() => {
      const item = document.querySelector('.grid-col .profile-item')
      if (item) item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`
  )
  await new Promise((r) => setTimeout(r, 800))
  const afterOpen = await win.webContents.executeJavaScript(
    `(() => ({
      tabCount: document.querySelectorAll('.tab').length,
      paneCount: document.querySelectorAll('.session-pane').length,
      homeTab: !!document.querySelector('.tab-home'),
      homeActive: document.querySelector('.tab-home')?.classList.contains('active')
    }))()`
  )
  console.log('[test] AFTER_OPEN:', JSON.stringify(afterOpen))

  // 从会话 tab 切回首页
  await win.webContents.executeJavaScript(
    `(() => { const h = document.querySelector('.tab-home'); if (h) h.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`
  )
  await new Promise((r) => setTimeout(r, 400))
  const homeSwitch = await win.webContents.executeJavaScript(
    `(() => ({
      grid: !!document.querySelector('.grid-view'),
      homeActive: document.querySelector('.tab-home')?.classList.contains('active')
    }))()`
  )
  console.log('[test] HOME_SWITCH:', JSON.stringify(homeSwitch))

  await win.webContents.executeJavaScript(
    `(() => {
      const add = document.querySelector('.tab-add')
      if (add) add.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`
  )
  await new Promise((r) => setTimeout(r, 500))
  const quick = await win.webContents.executeJavaScript(
    `(() => ({
      dialog: !!document.querySelector('.quick-dialog'),
      groups: document.querySelectorAll('.quick-group').length
    }))()`
  )
  console.log('[test] QUICK:', JSON.stringify(quick))

  app.exit(0)
})
