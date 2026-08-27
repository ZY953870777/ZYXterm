#!/usr/bin/env node
/**
 * RDP utility process 方案测试：fork src/main/rdp-worker.cjs，验证
 * - worker 能加载 addon、连接服务器、返回帧
 * - 主进程收到 status/frame/resize 消息（隔离进程通信）
 * 用法：env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/test-rdp-utility.cjs
 */
const { app, utilityProcess } = require('electron')
const path = require('node:path')

app.whenReady().then(() => {
  const worker = utilityProcess.fork(
    path.join(process.cwd(), 'src', 'main', 'rdp-worker.cjs'),
    [],
    { serviceName: 'test-rdp', stdio: 'inherit' }
  )
  let frames = 0
  let bytes = 0

  worker.on('message', (e) => {
    if (!e || typeof e !== 'object') return
    if (e.type === 'ready') {
      console.log('[test] worker ready，开始连接')
      worker.postMessage({
        cmd: 'init',
        config: {
          host: process.env.RDP_HOST || '10.10.186.32',
          port: Number(process.env.RDP_PORT) || 3389,
          username: process.env.RDP_USER || 'cn1135',
          password: process.env.RDP_PASS || '',
          domain: process.env.RDP_DOMAIN || 'verisilicon',
          width: 1280,
          height: 720
        }
      })
      return
    }
    if (e.type === 'frame' && e.payload) {
      frames++
      bytes += e.payload.data ? e.payload.data.length : 0
      if (frames <= 3) {
        console.log(
          `[test] frame #${frames} ${e.payload.width}x${e.payload.height} bytes=${e.payload.data?.length}`
        )
      }
      return
    }
    console.log(`[test] ${e.type}: ${typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)}`)
  })
  worker.on('exit', (code) => {
    console.log(`[test] worker exit code=${code}`)
  })

  const timeoutMs = Number(process.env.RDP_TIMEOUT) || 15000
  setTimeout(() => {
    console.log(`[test] 帧统计: count=${frames} bytes=${bytes}`)
    try {
      worker.kill()
    } catch {
      /* ignore */
    }
    app.exit(0)
  }, Math.min(timeoutMs, 12000))
})
