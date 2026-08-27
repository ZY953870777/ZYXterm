#!/usr/bin/env node
/**
 * Windows 调试脚本：直接加载 Windows 版 freerdp.node（PE）并连接 RDP，
 * 用于在打包 app 之前快速复现/定位崩溃。
 *
 * 用法（Windows 项目目录）：
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/debug-rdp-win.cjs
 * 环境变量：RDP_HOST / RDP_PORT / RDP_USER / RDP_PASS / RDP_DOMAIN / RDP_TIMEOUT
 * addon 来源：resources/freerdp/freerdp.node（或 build/Release/）
 */
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const addonCands = [
  path.join(__dirname, '..', 'resources', 'freerdp', 'freerdp.node'),
  path.join(__dirname, '..', 'resources', 'freerdp', 'build', 'Release', 'freerdp.node')
]
const addonPath = addonCands.find((c) => fs.existsSync(c))
if (!addonPath) {
  console.error('[debug] 未找到 freerdp.node（resources/freerdp/ 下）')
  app.exit(1)
}

process.on('uncaughtException', (e) => {
  console.error('[debug] uncaughtException:', e && e.message ? e.message : e)
})
process.on('unhandledRejection', (e) => {
  console.error('[debug] unhandledRejection:', e && e.message ? e.message : e)
})

const addon = require(addonPath)

app.whenReady().then(() => {
  const host = process.env.RDP_HOST || '10.10.186.32'
  const port = Number(process.env.RDP_PORT) || 3389
  const username = process.env.RDP_USER || 'cn1135'
  const password = process.env.RDP_PASS || ''
  const domain = process.env.RDP_DOMAIN || 'verisilicon'
  const timeoutMs = Number(process.env.RDP_TIMEOUT) || 20000

  console.log(`[debug] addon: ${addonPath}`)
  console.log(`[debug] 连接 ${host}:${port} (${username}@${domain})`)

  let frames = 0
  const s = new addon.RdpSession(
    { host, port, username, password, domain, width: 1024, height: 600 },
    (type, payload) => {
      if (type === 'frame') {
        frames++
        if (frames <= 3) console.log(`[debug] frame #${frames} ${payload.width}x${payload.height}`)
        return
      }
      console.log(`[debug] event ${type}: ${payload}`)
    }
  )
  s.connect()

  setTimeout(() => {
    console.log(`[debug] ${timeoutMs / 1000}s 结束，frames=${frames}`)
    try {
      s.disconnect()
    } catch (e) {
      console.error('[debug] disconnect err:', e)
    }
    app.exit(0)
  }, timeoutMs)
})
