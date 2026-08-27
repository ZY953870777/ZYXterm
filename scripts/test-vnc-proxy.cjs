#!/usr/bin/env node
/**
 * 本地验证 VNC 代理（ws↔tcp 双向转发）是否正常。
 * 模拟：假 VNC TCP 服务器 + 主进程代理逻辑 + ws 客户端。
 * 若输出显示双向字节到达，说明代理机制正常。
 */
const net = require('node:net')
const { WebSocketServer, WebSocket } = require('ws')

// ---------- 1. 假 VNC 服务器：收到字节原样回显 ----------
const fake = net.createServer((sock) => {
  console.log('[fake-vnc] 客户端已连接')
  sock.on('data', (d) => {
    console.log(
      `[fake-vnc] 收到 ${d.length} 字节 → 回显: "${d.toString().trim()}"`
    )
    sock.write(d) // 原样回显，模拟服务器响应
  })
})
fake.listen(5999, '127.0.0.1', () => console.log('[fake-vnc] 监听 :5999'))

// ---------- 2. WebSocket 代理（与 vnc.ts 相同逻辑） ----------
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
wss.on('listening', () => {
  console.log('[proxy] WebSocket 监听端口:', wss.address().port)
})
wss.on('connection', (ws) => {
  const tcp = net.createConnection({ host: '127.0.0.1', port: 5999 })
  tcp.on('data', (d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d)
  })
  tcp.on('error', (e) => console.log('[proxy] tcp 错误:', e.message))
  tcp.on('close', () => ws.close())
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    console.log(`[proxy] ws→tcp ${buf.length} 字节`)
    tcp.write(buf)
  })
  ws.on('close', () => tcp.destroy())
})

// ---------- 3. ws 客户端连代理发送 RFB 握手 ----------
setTimeout(() => {
  const url = `ws://127.0.0.1:${wss.address().port}/websockify`
  const client = new WebSocket(url)
  client.on('open', () => {
    console.log('[client] ws 已连接，发送 RFB 握手: "RFB 003.008\\n"')
    client.send(Buffer.from('RFB 003.008\n'))
  })
  client.on('message', (data) => {
    const buf = Buffer.from(data)
    console.log(`[client] 收到回显 ${buf.length} 字节: "${buf.toString().trim()}"`)
    console.log('\n✅ 代理双向转发正常！')
    process.exit(0)
  })
  client.on('error', (e) => console.log('[client] 错误:', e.message))
}, 300)
