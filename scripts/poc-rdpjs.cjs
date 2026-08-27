#!/usr/bin/env node
/**
 * node-rdpjs PoC：验证纯 JS RDP 客户端能否连接目标 RDP 服务器并接收画面帧。
 *
 * 用法：
 *   RDP_HOST=192.168.x.x RDP_PORT=3389 RDP_USER=user RDP_PASS=pass \
 *     node scripts/poc-rdpjs.cjs
 *
 * 环境变量：
 *   RDP_HOST    RDP 服务器地址（默认 127.0.0.1）
 *   RDP_PORT    RDP 端口（默认 3389）
 *   RDP_USER    RDP 用户名（默认 Administrator）
 *   RDP_PASS    RDP 密码
 *   RDP_DOMAIN  RDP 域（可选）
 *   RDP_WIDTH   RDP 宽度（默认 1280）
 *   RDP_HEIGHT  RDP 高度（默认 720）
 *   RDP_TIMEOUT 连接超时秒数（默认 20）
 *   RDP_FRAMES  收到多少帧后自动退出（默认 5，0=不自动退出）
 *   RDP_LOCALE  键盘布局 en/fr（默认 en）
 *
 * 说明：
 * - node-rdpjs 只支持 SSL 安全层（不支持 NLA）。若目标 Windows RDP 强制 NLA-only
 *   将无法连接；Windows 默认允许非 NLA 降级则可连接。
 * - 收到首帧会自动保存为 /tmp/poc-rdpjs-frame.ppm 便于查看画面。
 */
const rdp = require('node-rdpjs')
const fs = require('fs')

const host = process.env.RDP_HOST || '127.0.0.1'
const port = Number(process.env.RDP_PORT) || 3389
const userName = process.env.RDP_USER || 'Administrator'
const password = process.env.RDP_PASS || ''
const domain = process.env.RDP_DOMAIN || ''
const width = Number(process.env.RDP_WIDTH) || 1280
const height = Number(process.env.RDP_HEIGHT) || 720
const timeoutS = Number(process.env.RDP_TIMEOUT) || 20
const framesToStop = Number(process.env.RDP_FRAMES) || 5

let bitmapCount = 0
let bytesTotal = 0
let connected = false
let done = false
let first = null

const timer = setTimeout(() => {
  finish(
    1,
    `超时（${timeoutS}s）未完成连接。connected=${connected}, bitmap=${bitmapCount}`
  )
}, timeoutS * 1000)

function finish(code, msg) {
  if (done) return
  done = true
  clearTimeout(timer)
  if (msg) console.log('[poc]', msg)
  try {
    client.close()
  } catch {
    /* ignore */
  }
  process.exit(code)
}

/** 把 bitmap.data 转换为 PPM（RGB）以便查看画面 */
function rgbToPpm(bitmap) {
  const w = bitmap.width
  const h = bitmap.height
  const bpp = bitmap.bitsPerPixel
  const src = bitmap.data
  const bytes = bpp >> 3
  const out = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const off = i * bytes
    if (bpp === 32) {
      out[i * 3] = src[off + 2]
      out[i * 3 + 1] = src[off + 1]
      out[i * 3 + 2] = src[off]
    } else if (bpp === 24) {
      out[i * 3] = src[off + 2]
      out[i * 3 + 1] = src[off + 1]
      out[i * 3 + 2] = src[off]
    } else if (bpp === 16) {
      const v = src.readUInt16LE(off)
      const r = (v >> 11) & 0x1f
      const g = (v >> 5) & 0x3f
      const b = v & 0x1f
      out[i * 3] = (r << 3) | (r >> 2)
      out[i * 3 + 1] = (g << 2) | (g >> 4)
      out[i * 3 + 2] = (b << 3) | (b >> 2)
    } else {
      out[i * 3] = src[off]
      out[i * 3 + 1] = src[off + 1]
      out[i * 3 + 2] = src[off + 2]
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), out])
}

const client = rdp.createClient({
  domain,
  userName,
  password,
  enablePerf: true,
  autoLogin: true,
  decompress: true,
  screen: { width, height },
  locale: process.env.RDP_LOCALE || 'en',
  logLevel: process.env.RDP_LOGLEVEL || 'WARN'
})

client.on('connect', () => {
  connected = true
  console.log('[poc] ✅ RDP 连接成功（connect 事件）')
})

client.on('close', () => {
  console.log('[poc] 连接已关闭')
  finish(0)
})

client.on('error', (err) => {
  console.log(
    '[poc] ❌ 错误:',
    err && err.message ? err.message : String(err)
  )
  finish(1)
})

client.on('bitmap', (b) => {
  bitmapCount++
  bytesTotal += b.data ? b.data.length : 0
  if (!first) {
    first = {
      width: b.width,
      height: b.height,
      bitsPerPixel: b.bitsPerPixel,
      isCompress: b.isCompress
    }
    const path = '/tmp/poc-rdpjs-frame.ppm'
    try {
      fs.writeFileSync(path, rgbToPpm(b))
      console.log('[poc] 首帧已保存:', path)
    } catch (e) {
      console.log('[poc] 保存首帧失败:', e.message)
    }
  }
  if (bitmapCount % 10 === 0 || bitmapCount <= 3) {
    console.log(
      `[poc] bitmap #${bitmapCount} size=${b.width}x${b.height} bpp=${b.bitsPerPixel} compress=${b.isCompress} bytes=${bytesTotal}`
    )
  }
  if (framesToStop > 0 && bitmapCount >= framesToStop) {
    console.log(`[poc] 已收到 ${bitmapCount} 帧，按预期退出`)
    finish(0)
  }
})

console.log(
  `[poc] 连接 ${host}:${port} (${userName}@${domain || '(无域)'}) 分辨率 ${width}x${height}`
)
try {
  client.connect(host, port)
} catch (e) {
  console.log('[poc] 连接异常:', e.message)
  finish(1)
}
