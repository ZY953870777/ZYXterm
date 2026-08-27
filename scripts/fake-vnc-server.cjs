#!/usr/bin/env node
/**
 * 最小 RFB 3.8 假 VNC 服务器（用于本地端到端测试 novnc 渲染）
 * 注意：RFB 协议中【服务器先发送版本】，客户端响应。
 * - 连接建立后主动发 "RFB 003.008\n"
 * - 收客户端版本 → 发安全类型 [NoAuth]
 * - 收安全选择 → SecurityResult + ServerInit
 * - 收 SetPixelFormat/SetEncodings/FBUpdateRequest → 发送一帧纯色画面
 */
const net = require('node:net')

function createFakeVncServer(port, { width = 640, height = 480 } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      console.log('[fake-vnc] 客户端已连接，服务器先发版本...')
      let state = 0 // 0=已发版本等客户端 1=等安全选择 2=已初始化 3=运行

      // 运行期字节流缓冲：解析客户端消息（Keyboard/Pointer/CutText 等）
      let streamBuf = Buffer.alloc(0)
      const parseMessages = (d) => {
        streamBuf = Buffer.concat([streamBuf, d])
        while (streamBuf.length >= 1) {
          const type = streamBuf[0]
          let msgLen
          if (type === 0) {
            msgLen = 20 // SetPixelFormat
          } else if (type === 2) {
            if (streamBuf.length < 4) break
            msgLen = 4 + streamBuf.readUInt16BE(2) * 4 // SetEncodings
          } else if (type === 3) {
            msgLen = 10 // FramebufferUpdateRequest
          } else if (type === 4) {
            msgLen = 8 // KeyEvent
          } else if (type === 5) {
            msgLen = 6 // PointerEvent: type(1) buttonMask(1) x(2) y(2)
          } else if (type === 6) {
            if (streamBuf.length < 8) break
            msgLen = 8 + streamBuf.readUInt32BE(4) // ClientCutText
          } else {
            break
          }
          if (streamBuf.length < msgLen) break
          if (type === 5) {
            server.__lastPointer = {
              x: streamBuf.readUInt16BE(2),
              y: streamBuf.readUInt16BE(4),
              bmask: streamBuf[1]
            }
            console.log(
              `[fake-vnc] PointerEvent x=${server.__lastPointer.x} y=${server.__lastPointer.y} mask=${server.__lastPointer.bmask}`
            )
          }
          streamBuf = streamBuf.subarray(msgLen)
        }
      }

      const sendServerInit = () => {
        const head = Buffer.alloc(20)
        head.writeUInt16BE(width, 0)
        head.writeUInt16BE(height, 2)
        head[4] = 32 // bits-per-pixel
        head[5] = 24 // depth
        head[6] = 0 // big-endian
        head[7] = 1 // true-color
        head.writeUInt16BE(255, 8)
        head.writeUInt16BE(255, 10)
        head.writeUInt16BE(255, 12)
        head[14] = 16 // red-shift
        head[15] = 8 // green-shift
        head[16] = 0 // blue-shift
        const name = Buffer.from('FakeVNC')
        const nameLen = Buffer.alloc(4)
        nameLen.writeUInt32BE(name.length, 0)
        sock.write(Buffer.concat([head, nameLen, name]))
        console.log(`[fake-vnc] ServerInit 已发送 (${width}x${height})`)
      }

      const sendFrame = () => {
        const bpp = 4
        const w = width
        const h = height
        // FramebufferUpdate: type(1) + padding(1) + nRects(2) + rect(x,y,w,h,encoding)(12) + data
        const buf = Buffer.alloc(4 + 12 + w * h * bpp)
        buf[0] = 0 // type
        buf[1] = 0 // padding
        buf.writeUInt16BE(1, 2) // nRects
        buf.writeUInt16BE(0, 4) // x
        buf.writeUInt16BE(0, 6) // y
        buf.writeUInt16BE(w, 8) // w
        buf.writeUInt16BE(h, 10) // h
        buf.writeUInt32BE(0, 12) // encoding Raw
        let o = 16
        for (let i = 0; i < w * h; i++) {
          buf[o + i * 4] = 0
          buf[o + i * 4 + 1] = 120
          buf[o + i * 4 + 2] = 255
          buf[o + i * 4 + 3] = 0
        }
        sock.write(buf)
        console.log('[fake-vnc] 已发送一帧纯色画面')
      }

      // 服务器先发版本
      sock.write(Buffer.from('RFB 003.008\n'))

      sock.on('data', (d) => {
        console.log('[fake-vnc] 收到', d.length, '字节:', d.toString('hex').slice(0, 48))
        // 记录进入本回调前是否已是运行态：握手期（state 2→3）的那条 data
        // 可能包含无法完整解析的消息，若进入解析会污染 streamBuf，导致后续
        // 鼠标事件解析错位。因此只有「本来就是运行态」的 data 才做消息解析。
        const wasState3 = state === 3
        if (state === 0) {
          // RFB 3.8：安全类型数量为 1 字节。发 [数量=1, 类型=1(NoAuth)]
          sock.write(Buffer.from([1, 1]))
          state = 1
        } else if (state === 1) {
          // 客户端选安全类型 → SecurityResult + ServerInit
          sock.write(Buffer.from([0, 0, 0, 0]))
          sendServerInit()
          state = 2
        } else if (state === 2) {
          // SetPixelFormat/SetEncodings/FBUpdateRequest → 发帧
          sendFrame()
          state = 3
          streamBuf = Buffer.alloc(0) // 丢弃握手期残留
        }
        // 运行态才解析键盘/鼠标事件
        if (wasState3) {
          parseMessages(d)
        }
      })

      sock.on('error', () => {})
      sock.on('close', () => console.log('[fake-vnc] 客户端断开'))
    })

    server.listen(port, '127.0.0.1', () => {
      console.log(`[fake-vnc] 监听 127.0.0.1:${port}`)
      resolve(server)
    })
  })
}

module.exports = { createFakeVncServer }

if (require.main === module) {
  createFakeVncServer(5999).then(() => {
    console.log('[fake-vnc] 运行中 (Ctrl+C 退出)')
  })
}
