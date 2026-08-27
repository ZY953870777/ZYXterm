import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { ConnectionProfile, SessionInfo } from '@shared/types'
import { BaseSession, SendFn } from './types'
import { SSHSession } from './ssh'
import { SerialSession } from './serial'
import { VNCSession } from './vnc'
import { RDPSession2 } from './rdp2'

/**
 * 连接管理器：统一创建/销毁各种协议会话，并负责
 * 主进程 -> 渲染进程 的事件推送。
 */
export class ConnectionManager {
  private sessions = new Map<string, BaseSession>()

  /** 多窗口：会话状态/终端数据广播到所有窗口，由各窗口按 sessionId 自行过滤 */
  private send: SendFn = (channel, ...args) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  /** 创建并建立一条连接 */
  async create(profile: ConnectionProfile): Promise<SessionInfo> {
    const sessionId = randomUUID()
    let session: BaseSession
    switch (profile.protocol) {
      case 'ssh':
        session = new SSHSession(sessionId, profile, this.send)
        break
      case 'serial':
        session = new SerialSession(sessionId, profile, this.send)
        break
      case 'vnc':
        session = new VNCSession(sessionId, profile, this.send)
        break
      case 'rdp':
        session = new RDPSession2(sessionId, profile, this.send)
        break
      default:
        throw new Error(`不支持的协议: ${profile.protocol}`)
    }
    this.sessions.set(sessionId, session)
    this.emitStatus(session)
    // 异步建立连接，错误/状态变化通过 connection:status 事件通知
    session.connect().catch(() => {
      /* 状态已通过事件上报 */
    })
    return this.toInfo(session)
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write?.(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.resize?.(cols, rows)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.dispose()
      this.sessions.delete(sessionId)
    }
  }

  get(sessionId: string): BaseSession | undefined {
    return this.sessions.get(sessionId)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toInfo(s))
  }

  async disposeAll(): Promise<void> {
    const jobs = [...this.sessions.values()].map((s) => s.dispose())
    this.sessions.clear()
    await Promise.allSettled(jobs)
  }

  private emitStatus(session: BaseSession): void {
    this.send('connection:status', this.toInfo(session))
  }

  private toInfo(session: BaseSession): SessionInfo {
    const info: SessionInfo = {
      sessionId: session.sessionId,
      profileId: session.profile.id,
      name: session.profile.name,
      protocol: session.profile.protocol,
      status: session.status,
      message: session.error
    }
    if (session instanceof VNCSession) {
      info.wsEndpoint = session.wsEndpoint
    }
    return info
  }
}
