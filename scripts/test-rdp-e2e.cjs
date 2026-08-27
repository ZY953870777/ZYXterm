#!/usr/bin/env node
/**
 * RDP 端到端测试（FreeRDP 嵌入式，utility process 方案）：
 * - 真实 renderer + preload + 真实 FreeRDP addon（Electron ABI）
 * - session:create fork src/main/rdp-worker.cjs（独立进程加载 addon）
 * - 验证：双击打开 RDP → worker 连接 → 主进程广播 rdp:frame → renderer canvas 收到画面
 * 用法：env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/test-rdp-e2e.cjs
 * 环境变量：RDP_HOST / RDP_PORT / RDP_USER / RDP_PASS / RDP_DOMAIN
 */
const path = require('node:path')
const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron')

const host = process.env.RDP_HOST || '127.0.0.1'
const port = Number(process.env.RDP_PORT) || 3389
const username = process.env.RDP_USER || 'Administrator'
const password = process.env.RDP_PASS || ''
const domain = process.env.RDP_DOMAIN || ''
const workerPath = path.join(process.cwd(), 'src', 'main', 'rdp-worker.cjs')

// ---------- IPC stubs ----------
let worker = null
let frameCount = 0

const broadcast = (ch, ...args) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(ch, ...args)
  }
}

ipcMain.handle('profiles:list', () => [
  {
    id: 'r1',
    name: 'RDP测试',
    protocol: 'rdp',
    rdp: { host, port, username, password, domain },
    createdAt: 0
  }
])
ipcMain.handle('session:create', (_e, profile) => {
  const sessionId = 'rdp-test-1'
  const rdp = profile.rdp
  worker = utilityProcess.fork(workerPath, [], { serviceName: 'test-rdp' })
  worker.on('message', (e) => {
    if (!e || typeof e !== 'object') return
    const type = e.type
    const payload = e.payload
    if (type === 'frame') {
      frameCount++
      broadcast('rdp:frame', sessionId, payload)
    } else if (type === 'status') {
      const status = payload === 'connected' ? 'connected' : 'connecting'
      broadcast('connection:status', {
        sessionId, profileId: 'r1', name: 'RDP测试', protocol: 'rdp',
        status, message: undefined
      })
    } else if (type === 'error') {
      broadcast('connection:status', {
        sessionId, profileId: 'r1', name: 'RDP测试', protocol: 'rdp',
        status: 'error', message: String(payload)
      })
    }
  })
  worker.on('exit', (code) => {
    console.log('[test] worker exit code=' + code)
  })
  worker.postMessage({
    cmd: 'init',
    config: {
      host: rdp.host,
      port: rdp.port,
      username: rdp.username ?? '',
      password: rdp.password ?? '',
      domain: rdp.domain ?? '',
      width: 1280,
      height: 720
    }
  })
  return {
    sessionId, profileId: 'r1', name: 'RDP测试', protocol: 'rdp', status: 'connecting'
  }
})
ipcMain.handle('session:close', () => {})
ipcMain.handle('session:list', () => [])
ipcMain.handle('profiles:save', () => ({ id: 'r1' }))
ipcMain.handle('profiles:update', () => ({}))
ipcMain.handle('profiles:delete', () => true)
ipcMain.handle('vnc:endpoint', () => null)
ipcMain.handle('clipboard:read', () => '')
ipcMain.handle('clipboard:write', () => {})
ipcMain.handle('rdp:detect', () => ({ available: true }))
ipcMain.handle('serial:list', () => [])
ipcMain.handle('dialog:selectFile', () => null)
ipcMain.on('rdp:input', (_e, id, input) => {
  console.log('[test] rdp:input', id, JSON.stringify(input))
  worker?.postMessage({ cmd: 'input', input })
})
ipcMain.on('window:register', () => {})
ipcMain.on('tabs:changed', () => {})

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1500))

  // 双击 RDP profile 打开
  await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.grid-col .profile-item')]
    const item = items.find((el) => el.querySelector('.profile-name')?.textContent === 'RDP测试') || items[0]
    if (!item) return 'NO_ITEM'
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return 'DBL'
  })()`)
  await new Promise((r) => setTimeout(r, 8000))

  // 检查 renderer canvas 是否收到画面
  const stat = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('.rdp-view2 canvas')
    if (!c) return { canvas: false }
    const ctx = c.getContext('2d')
    const img = ctx.getImageData(0, 0, c.width, c.height).data
    let nonBlack = 0
    for (let i = 0; i < img.length; i += 16) {
      if (img[i] || img[i + 1] || img[i + 2]) nonBlack++
    }
    return { canvas: true, w: c.width, h: c.height, nonBlack }
  })()`)

  console.log('[test] RDP E2E:', JSON.stringify(stat))
  console.log('[test] frame 广播次数:', frameCount)
  try {
    worker?.kill()
  } catch {
    /* ignore */
  }
  app.exit(0)
})
