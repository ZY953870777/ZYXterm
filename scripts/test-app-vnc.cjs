#!/usr/bin/env node
/**
 * 用真实 renderer + preload 端到端验证 VNC：
 * - 假 VNC 服务器（RFB 握手 + 一帧）
 * - 主进程模拟 VNC 会话 IPC（同步返回已就绪 wsEndpoint + ws 代理）
 * - 真实 out/renderer + out/preload，Sidebar 双击创建 VNC 会话
 * - 检查 canvas 尺寸 / 缩放 style / 像素；模拟窗口 resize 验证缩放跟随
 */
const path = require('node:path')
const net = require('node:net')
const { app, BrowserWindow, ipcMain } = require('electron')
const { WebSocketServer } = require('ws')
const { createFakeVncServer } = require('./fake-vnc-server.cjs')

function makeProxy(wss, targetPort) {
  wss.on('connection', (ws) => {
    const tcp = net.createConnection({ host: '127.0.0.1', port: targetPort })
    tcp.on('data', (d) => ws.readyState === 1 && ws.send(d))
    tcp.on('error', () => {})
    tcp.on('close', () => ws.close())
    ws.on('message', (d) => tcp.write(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    ws.on('close', () => tcp.destroy())
  })
}

app.whenReady().then(async () => {
  const vncServer = await createFakeVncServer(5999)

  const sessionWss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sessionWsUrl = await new Promise((r) =>
    sessionWss.once('listening', () =>
      r('ws://127.0.0.1:' + sessionWss.address().port + '/websockify')
    )
  )
  makeProxy(sessionWss, 5999)
  const sessions = new Map()

  ipcMain.handle('session:create', async (_e, profile) => {
    const id = 'test-' + Date.now() + '-' + profile.protocol
    sessions.set(id, sessionWsUrl)
    return {
      sessionId: id,
      profileId: 'x',
      name: profile.name,
      protocol: profile.protocol,
      status: 'connected',
      wsEndpoint: profile.protocol === 'vnc' ? sessionWsUrl : undefined
    }
  })
  ipcMain.handle('vnc:endpoint', (_e, id) => sessions.get(id) ?? null)
  ipcMain.handle('clipboard:read', () => '')
  ipcMain.handle('clipboard:write', () => {})
  ipcMain.handle('profiles:list', () => [
    {
      id: 'p1',
      name: 'VNC测试',
      protocol: 'vnc',
      vnc: {
        host: '127.0.0.1',
        port: 5999,
        password: '',
        viewOnly: false,
        scaleView: true,
        quality: 6,
        scaleMode: 'fill'
      },
      createdAt: 0
    },
    {
      id: 'p2',
      name: 'SSH测试',
      protocol: 'ssh',
      ssh: {
        host: '127.0.0.1',
        port: 22,
        username: 'user',
        authType: 'password',
        password: ''
      },
      createdAt: 0
    }
  ])
  ipcMain.handle('rdp:detect', () => ({ available: false }))
  ipcMain.handle('serial:list', () => [])
  ipcMain.handle('dialog:selectFile', () => null)
  ipcMain.handle('session:close', () => {})
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('profiles:save', () => ({ id: 'x' }))
  ipcMain.handle('profiles:update', () => ({}))
  ipcMain.handle('profiles:delete', () => true)

  const win = new BrowserWindow({
    width: 1000,
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

  // 记录页面内 window resize 事件触发次数
  await win.webContents.executeJavaScript(
    `window.__resizeCount = 0; window.addEventListener('resize', () => { window.__resizeCount++ }); true`
  )

  // 首页协议徽章颜色：SSH 紫 / VNC 蓝（对换后）
  console.log(
    '[test] home badges:',
    await win.webContents.executeJavaScript(
      `(() => {
        const get = (sel) => {
          const el = document.querySelector(sel)
          return el ? getComputedStyle(el).backgroundColor : 'NA'
        }
        return 'ssh=' + get('.proto-badge.ssh') + ' vnc=' + get('.proto-badge.vnc')
      })()`
    )
  )

  await win.webContents
    .executeJavaScript(
      `(() => {
        const items = [...document.querySelectorAll('.grid-col .profile-item')]
        const item = items.find((el) => el.querySelector('.profile-name')?.textContent === 'VNC测试') || items[0]
        if (!item) return 'NO_ITEM'
        item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
        return 'DBLCLICKED'
      })()`
    )
    .then((r) => console.log('[test] trigger:', r))

  await new Promise((r) => setTimeout(r, 6000))

  const readDiag = () =>
    win.webContents.executeJavaScript(
      `(() => {
        const c = document.querySelector('.vnc-canvas-wrap canvas')
        const wrap = document.querySelector('.vnc-canvas-wrap')
        if (!c) return 'NO_CANVAS'
        let px = -1
        try {
          const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
          let n = 0
          for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++
          px = n
        } catch (e) { px = 'err' }
        const r = c.getBoundingClientRect()
        return 'canvas=' + c.width + 'x' + c.height +
               ' visual=' + Math.round(r.width) + 'x' + Math.round(r.height) +
               ' tf=' + (c.style.transform || 'none') +
               ' wrap=' + (wrap ? wrap.clientWidth + 'x' + wrap.clientHeight : '?') +
               ' win=' + window.innerWidth + 'x' + window.innerHeight +
               ' canvases=' + document.querySelectorAll('.vnc-canvas-wrap canvas').length +
               ' resizes=' + (window.__resizeCount || 0) +
               ' px=' + px
      })()`
    )

  // 在 canvas 视觉中心模拟一次鼠标点击，验证 novnc 发给服务器的坐标
  // 能正确换算回服务器分辨率（640x480 中心 = 320,240），即鼠标与画面不错位
  const clickAtCenter = async (label) => {
    const ret = await win.webContents.executeJavaScript(
      `(() => {
        const c = document.querySelector('.vnc-canvas-wrap canvas')
        if (!c) return 'NO_CANVAS'
        const r = c.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const evLog = []
        const ln = (e) => evLog.push(e.type)
        c.addEventListener('mousedown', ln)
        c.addEventListener('mouseup', ln)
        c.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, buttons: 1, bubbles: true, cancelable: true }))
        c.dispatchEvent(new MouseEvent('mouseup', { clientX: cx, clientY: cy, buttons: 0, bubbles: true, cancelable: true }))
        c.removeEventListener('mousedown', ln)
        c.removeEventListener('mouseup', ln)
        return 'CLICKED ' + Math.round(cx) + ',' + Math.round(cy) +
               ' evts=' + (evLog.join(',') || 'NONE')
      })()`
    )
    console.log(`[test] ${label} click:`, ret)
    await new Promise((r) => setTimeout(r, 500))
    console.log(
      `[test] ${label} serverPointer:`,
      JSON.stringify(vncServer.__lastPointer || null)
    )
  }

  console.log('[test] BEFORE_RESIZE:', await readDiag())
  await clickAtCenter('BEFORE')
  win.setSize(1400, 900)
  await new Promise((r) => setTimeout(r, 1500))
  console.log('[test] AFTER_RESIZE:', await readDiag())
  await clickAtCenter('AFTER')
  // 手动触发 resize 交叉验证：resize 监听仍能正确重算缩放
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new Event('resize')); true`
  )
  await new Promise((r) => setTimeout(r, 300))
  console.log('[test] AFTER_MANUAL_RESIZE:', await readDiag())

  // ---- 新 UI 验证：右键菜单 / tab 悬停 tooltip / 加号位置 ----
  // 1) 右键 tab 弹出菜单
  await win.webContents
    .executeJavaScript(
      `(() => {
        const tab = document.querySelector('.tabs .tab:not(.tab-home)')
        if (!tab) return 'NO_TAB'
        const r = tab.getBoundingClientRect()
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }))
        return 'CTX'
      })()`
    )
    .then((r) => console.log('[test] ctx trigger:', r))
  await new Promise((r) => setTimeout(r, 300))
  console.log(
    '[test] ctx menu:',
    await win.webContents.executeJavaScript(
      `(() => {
        const m = document.querySelector('.tab-menu')
        if (!m) return 'NO_MENU'
        return 'MENU=' + [...m.querySelectorAll('button')].map((b) => b.textContent).join('|')
      })()`
    )
  )
  // 关闭菜单（点击遮罩）
  await win.webContents.executeJavaScript(
    `(() => { const mask = document.querySelector('.tab-menu-mask'); if (mask) mask.click(); return true })()`
  )
  await new Promise((r) => setTimeout(r, 200))

  // 2) 悬停 tab 显示状态 tooltip
  await win.webContents
    .executeJavaScript(
      `(() => {
        const tab = document.querySelector('.tabs .tab:not(.tab-home)')
        if (!tab) return 'NO_TAB'
        tab.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        return true
      })()`
    )
    .then(() => {})
  await new Promise((r) => setTimeout(r, 300))
  console.log(
    '[test] tab tooltip:',
    await win.webContents.executeJavaScript(
      `(() => {
        const t = document.querySelector('.tab-tooltip')
        if (!t) return 'NO_TIP'
        return 'TIP=' + (t.querySelector('.tab-tooltip-name')?.textContent || '') +
               ' status=' + (t.querySelector('.tab-tooltip-status')?.textContent || '')
      })()`
    )
  )

  // 3) 加号紧跟最右 tab（marginLeft 非 auto）
  console.log(
    '[test] add-btn:',
    await win.webContents.executeJavaScript(
      `(() => {
        const add = document.querySelector('.tab-add')
        const tabs = document.querySelectorAll('.tabs .tab:not(.tab-home)')
        const last = tabs[tabs.length - 1]
        if (!add || !last) return 'NA'
        const ar = add.getBoundingClientRect()
        const lr = last.getBoundingClientRect()
        return 'marginLeft=' + getComputedStyle(add).marginLeft +
               ' gap=' + Math.round(ar.left - lr.right)
      })()`
    )
  )

  // ---- tab 协议徽章 / 拖拽排序验证 ----
  // 打开第二个 tab（SSH）：点加号 → QuickConnect → 双击 SSH 配置
  await win.webContents
    .executeJavaScript(
      `(() => { const add = document.querySelector('.tab-add'); if (add) add.click(); return 'QUICK_OPEN' })()`
    )
    .then((r) => console.log('[test] quick open:', r))
  await new Promise((r) => setTimeout(r, 400))
  await win.webContents
    .executeJavaScript(
      `(() => {
        const items = [...document.querySelectorAll('.quick-dialog .profile-item')]
        const ssh = items.find((el) => el.querySelector('.profile-name')?.textContent === 'SSH测试')
        if (!ssh) return 'NO_SSH'
        ssh.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
        return 'SSH_OPENED'
      })()`
    )
    .then((r) => console.log('[test] open ssh:', r))
  await new Promise((r) => setTimeout(r, 800))

  const readTabs = () =>
    win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('.tabs .tab:not(.tab-home) .proto-badge')].map((b) => b.textContent).join(',') || 'NO_TABS')()`
    )
  console.log('[test] tabs before drag:', await readTabs())

  // 拖拽第 1 个 tab 到第 2 个之后（pointer 事件：dragRef 为 ref，同步生效）
  await win.webContents
    .executeJavaScript(
      `(() => {
        const tabs = [...document.querySelectorAll('.tabs .tab:not(.tab-home)')]
        if (tabs.length < 2) return 'NEED_2'
        const r0 = tabs[0].getBoundingClientRect()
        const r1 = tabs[1].getBoundingClientRect()
        const cx0 = r0.left + r0.width / 2
        const cy0 = r0.top + r0.height / 2
        const fire = (type, x, y) => {
          tabs[0].dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
            clientX: x, clientY: y, button: 0,
            buttons: type === 'pointerup' ? 0 : 1
          }))
        }
        fire('pointerdown', cx0, cy0)
        fire('pointermove', r1.right + 20, cy0)
        fire('pointerup', r1.right + 20, cy0)
        return 'H_DRAG'
      })()`
    )
    .then((r) => console.log('[test] h-drag:', r))
  await new Promise((r) => setTimeout(r, 500))
  console.log('[test] tabs after drag:', await readTabs())

  // tab 徽章颜色（SSH 紫 / VNC 蓝）
  console.log(
    '[test] tab badges:',
    await win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('.tabs .tab:not(.tab-home)')].map((el) => {
        const b = el.querySelector('.proto-badge')
        return (b ? b.textContent : '?') + '=' + (b ? getComputedStyle(b).backgroundColor : '')
      }).join(',') || 'NO_TABS')()`
    )
  )

  // 断开/错误时徽章闪烁（连接正常时不闪烁）
  console.log(
    '[test] disconnected blink:',
    await win.webContents.executeJavaScript(
      `(() => {
        const tab = document.querySelector('.tabs .tab:not(.tab-home)')
        const badge = tab?.querySelector('.proto-badge')
        if (!tab || !badge) return 'NA'
        const normal = getComputedStyle(badge).animationName
        tab.classList.add('disconnected')
        const blink = getComputedStyle(badge).animationName
        tab.classList.remove('disconnected')
        return 'normal=' + normal + ' disconnected=' + blink
      })()`
    )
  )

  app.exit(0)
})
