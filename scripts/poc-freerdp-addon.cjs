#!/usr/bin/env node
/**
 * FreeRDP addon PoC：加载 native/freerdp/build/Release/freerdp.node，
 * 模拟主进程用法建立 RDP 会话并打印状态事件。
 *
 * 环境变量：
 *   RDP_HOST    RDP 服务器（默认 127.0.0.1）
 *   RDP_PORT    RDP 端口（默认 3389）
 *   RDP_USER    RDP 用户名（默认 Administrator）
 *   RDP_PASS    RDP 密码
 *   RDP_DOMAIN  RDP 域（可选）
 *   RDP_WIDTH/HEIGHT 分辨率（默认 1280x720）
 *   RDP_TIMEOUT 连接/运行超时毫秒（默认 20000）
 *   RDP_LINGER=1 连接成功后不自动退出（保持观察）
 */
const path = require('node:path')
const addon = require(path.join(
  __dirname,
  '..',
  'native',
  'freerdp',
  'build',
  'Release',
  'freerdp.node'
))

const host = process.env.RDP_HOST || '127.0.0.1'
const port = Number(process.env.RDP_PORT) || 3389
const username = process.env.RDP_USER || 'Administrator'
const password = process.env.RDP_PASS || ''
const domain = process.env.RDP_DOMAIN || ''
const width = Number(process.env.RDP_WIDTH) || 1280
const height = Number(process.env.RDP_HEIGHT) || 720
const timeoutMs = Number(process.env.RDP_TIMEOUT) || 20000

console.log(`[poc] 加载 addon OK`)
console.log(
  `[poc] 连接 ${host}:${port} (${username}@${domain || '(无域)'}) ${width}x${height}`
)

let frameCount = 0
let frameBytes = 0
const session = new addon.RdpSession(
  { host, port, username, password, domain, width, height },
  (type, payload) => {
    if (type === 'frame') {
      frameCount++
      frameBytes += payload.data.length
      if (frameCount <= 5) {
        console.log(
          `[addon] frame #${frameCount} x=${payload.x} y=${payload.y} ${payload.width}x${payload.height} bytes=${payload.data.length}`
        )
      }
      return
    }
    console.log(`[addon] ${type}: ${payload}`)
  }
)

let finished = false
const finish = (code) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  try {
    session.disconnect()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

const timer = setTimeout(() => {
  console.log('[poc] ⏰ 超时退出')
  finish(2)
}, timeoutMs)

process.on('SIGINT', () => {
  console.log('[poc] Ctrl+C，退出')
  finish(0)
})

session.connect()

// 演示运行 8 秒；RDP_LINGER=1 时保持连接直到 Ctrl+C
setTimeout(() => {
  if (process.env.RDP_LINGER === '1') return
  console.log(`[poc] 帧统计: count=${frameCount} bytes=${frameBytes}`)
  console.log('[poc] 演示结束，断开')
  finish(0)
}, Math.min(timeoutMs, 8000))
