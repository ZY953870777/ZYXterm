#!/usr/bin/env node
/**
 * Electron 环境加载 FreeRDP addon 并连接测试（验证 Electron ABI 兼容 + 帧链路）。
 * 用法：env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/test-rdp-addon.cjs
 * 环境变量：RDP_HOST / RDP_PORT / RDP_USER / RDP_PASS / RDP_DOMAIN / RDP_TIMEOUT
 */
const { app } = require('electron')
const path = require('node:path')

const addon = require(path.join(
  __dirname, '..', 'native', 'freerdp', 'build', 'Release', 'freerdp.node'
))

app.whenReady().then(() => {
  const host = process.env.RDP_HOST || '127.0.0.1'
  const port = Number(process.env.RDP_PORT) || 3389
  const username = process.env.RDP_USER || 'Administrator'
  const password = process.env.RDP_PASS || ''
  const domain = process.env.RDP_DOMAIN || ''
  const timeoutMs = Number(process.env.RDP_TIMEOUT) || 15000

  console.log(`[test] addon loaded in Electron ${process.versions.electron}`)
  console.log(`[test] 连接 ${host}:${port} (${username}@${domain || '(无域)'})`)

  let frames = 0
  let bytes = 0
  const session = new addon.RdpSession(
    { host, port, username, password, domain, width: 1280, height: 720 },
    (type, payload) => {
      if (type === 'frame') {
        frames++
        bytes += payload.data.length
        if (frames <= 3) {
          console.log(
            `[test] frame #${frames} x=${payload.x} y=${payload.y} ${payload.width}x${payload.height} bytes=${payload.data.length}`
          )
        }
        return
      }
      console.log(`[test] ${type}: ${payload}`)
    }
  )
  session.connect()

  setTimeout(() => {
    console.log(`[test] 帧统计: count=${frames} bytes=${bytes}`)
    session.disconnect()
    app.exit(0)
  }, Math.min(timeoutMs, 10000))
})
