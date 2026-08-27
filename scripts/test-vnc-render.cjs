#!/usr/bin/env node
/**
 * 端到端验证 novnc 渲染 + 诊断 novnc 底层 WebSocket 状态。
 * 运行：npx electron scripts/test-vnc-render.cjs
 * 输出 [result] DIAG:ws=状态 canvas=宽x高 px=像素数（>0 渲染成功）
 */
const path = require('node:path')
const net = require('node:net')
const { app, BrowserWindow } = require('electron')
const { WebSocketServer } = require('ws')
const { createFakeVncServer } = require('./fake-vnc-server.cjs')

app.whenReady().then(async () => {
  await createFakeVncServer(5999)

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const wsPort = await new Promise((r) =>
    wss.once('listening', () => r(wss.address().port))
  )
  wss.on('connection', (ws) => {
    console.log('[proxy] ws 客户端已连接')
    const tcp = net.createConnection({ host: '127.0.0.1', port: 5999 })
    tcp.on('connect', () => console.log('[proxy] tcp 已连到 fake-vnc'))
    tcp.on('data', (d) => {
      console.log('[proxy] tcp→ws', d.length, '字节')
      ws.readyState === 1 && ws.send(d)
    })
    tcp.on('error', (e) => console.log('[proxy] tcp 错误:', e.message))
    tcp.on('close', () => ws.close())
    ws.on('message', (d) => {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(d)
      console.log('[proxy] ws→tcp', b.length, '字节:', b.toString('hex').slice(0, 40))
      tcp.write(b)
    })
    ws.on('close', () => tcp.destroy())
  })

  const novncPath = path.join(
    __dirname,
    '..',
    'node_modules',
    '@novnc',
    'novnc',
    'core',
    'rfb.js'
  )

  const html =
    '<!DOCTYPE html><html><body style="margin:0;background:#222">' +
    '<canvas id="v" width="640" height="480" style="border:1px solid #666"></canvas>' +
    '<script type="module">' +
    "import RFB from 'file://" + novncPath + "'" +
    "const c = document.getElementById('v');" +
    "const rfb = new RFB(c, 'ws://127.0.0.1:" + wsPort + "/websockify', {});" +
    "rfb.addEventListener('connect', () => { document.title = 'CONNECTED'; });" +
    "rfb.addEventListener('disconnect', (e) => { document.title = 'DISCONNECT:' + (e.detail?.reason || ''); });" +
    "rfb.addEventListener('securityfailure', (e) => { document.title = 'SECURITY:' + (e.detail?.reason || ''); });" +
    'setTimeout(() => {' +
    "  let wsState = '?';" +
    "  try { wsState = String(rfb._sock.getState()); } catch (e) { wsState = 'err:' + e.message; }" +
    "  let pixels = -1;" +
    "  try { const img = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for(let i=3;i<img.length;i+=4) if(img[i]>0) n++; pixels = n; } catch (e) { pixels = 'err'; }" +
    "  document.title = 'DIAG:ws=' + wsState + ' canvas=' + c.width + 'x' + c.height + ' px=' + pixels;" +
    '}, 3000);' +
    '</script></body></html>'

  const win = new BrowserWindow({
    width: 700,
    height: 520,
    show: false,
    webPreferences: { webSecurity: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.webContents.on('page-title-updated', (_e, title) => {
    console.log('[result]', title)
    if (/^(DIAG|CONNECTED|DISCONNECT|SECURITY)/.test(title)) {
      setTimeout(() => app.exit(0), 200)
    }
  })
  setTimeout(() => {
    console.log('[result] TIMEOUT')
    app.exit(1)
  }, 8000)
})
