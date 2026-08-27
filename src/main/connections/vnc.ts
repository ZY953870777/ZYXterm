import * as net from 'net'
import { WebSocketServer, WebSocket } from 'ws'
import { ConnectionProfile, ConnectionStatus } from '@shared/types'
import { BaseSession, SendFn } from './types'

/**
 * VNC 会话
 * 主进程监听本地 WebSocket 端口作为 WebSocket <-> TCP 双向代理，
 * 渲染进程使用 @novnc/novnc 的 RFB 客户端连接该 WebSocket，
 * 以 "裸 RFB"（direct）模式透传二进制数据到目标 VNC 服务器。
 */
export class VNCSession implements BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus = 'connecting'
  error?: string

  /** 渲染进程连接用的 WebSocket 地址 */
  wsEndpoint?: string

  private wss: WebSocketServer | null = null
  private sockets = new Set<net.Socket>()
  private readonly send: SendFn

  constructor(sessionId: string, profile: ConnectionProfile, send: SendFn) {
    this.sessionId = sessionId
    this.profile = profile
    this.send = send
  }

  connect(): Promise<void> {
    const cfg = this.profile.vnc
    if (!cfg) {
      this.setStatus('error', '缺少 VNC 配置')
      return Promise.reject(new Error('缺少 VNC 配置'))
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        this.wss = wss

        wss.on('error', (e: Error) => {
          this.setStatus('error', e.message)
        })

        wss.on('listening', () => {
          const addr = wss.address() as net.AddressInfo
          this.wsEndpoint = `ws://127.0.0.1:${addr.port}/websockify`
          this.setStatus('connected')
          resolve()
        })

        wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws, cfg.host, cfg.port)
        })
      } catch (e) {
        const err = e as Error
        this.setStatus('error', err.message)
        reject(err)
      }
    })
  }

  /** WebSocket 客户端与 VNC TCP 服务器之间的双向转发 */
  private handleConnection(ws: WebSocket, host: string, port: number): void {
    const tcp = net.createConnection({ host, port })
    this.sockets.add(tcp)

    const cleanup = (): void => {
      this.sockets.delete(tcp)
      try {
        tcp.destroy()
      } catch {
        /* ignore */
      }
    }

    tcp.on('connect', () => {
      // TCP 就绪后即可透传
    })

    tcp.on('data', (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    tcp.on('error', (e: Error) => {
      this.setStatus('error', `VNC TCP 错误: ${e.message}`)
      if (ws.readyState === WebSocket.OPEN) ws.close()
      cleanup()
    })

    tcp.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close()
      cleanup()
    })

    ws.on('message', (data) => {
      if (tcp.destroyed) return
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      tcp.write(buf)
    })

    ws.on('close', () => cleanup())
    ws.on('error', () => cleanup())
  }

  async dispose(): Promise<void> {
    this.setStatus('disconnected')
    for (const s of this.sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
    try {
      this.wss?.close()
    } catch {
      /* ignore */
    }
    this.wss = null
  }

  private setStatus(status: ConnectionStatus, message?: string): void {
    this.status = status
    this.error = message
    this.send('connection:status', {
      sessionId: this.sessionId,
      profileId: this.profile.id,
      name: this.profile.name,
      protocol: this.profile.protocol,
      status,
      message,
      wsEndpoint: this.wsEndpoint
    })
  }
}
