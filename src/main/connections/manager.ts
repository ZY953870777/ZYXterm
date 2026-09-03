import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import {
  ConnectionProfile,
  GlobalMacroStatus,
  GlobalMacroStep,
  SessionInfo
} from '@shared/types'
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

  // ---------- 跨会话（多 SSH/串口）联动自动化运行状态 ----------
  private gm: {
    cancelled: boolean
    targets: string[]
    names: string[]
    loop: number
    iter: number
    idx: number
    totalSteps: number
    tails: string[]
    unsubs: Array<() => void>
    waitTarget: number | null
    waitNeedle: string | null
    waitResolve: ((ok: boolean) => void) | null
    waitTimer: ReturnType<typeof setTimeout> | null
    sleepTimer: ReturnType<typeof setTimeout> | null
    sleepResolve: ((ok: boolean) => void) | null
  } | null = null

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
    this.stopGlobalMacro()
    const jobs = [...this.sessions.values()].map((s) => s.dispose())
    this.sessions.clear()
    await Promise.allSettled(jobs)
  }

  // ================= 跨会话（多 SSH/串口）联动自动化 =================

  /** 当前打开的、可参与联动的会话（SSH/串口且已连接） */
  listAutomationTargets(): {
    sessionId: string
    profileId: string
    name: string
    kind: 'ssh' | 'serial'
  }[] {
    const out: {
      sessionId: string
      profileId: string
      name: string
      kind: 'ssh' | 'serial'
    }[] = []
    for (const s of this.sessions.values()) {
      if (s.status !== 'connected' || !s.write || !s.subscribeData) continue
      out.push({
        sessionId: s.sessionId,
        profileId: s.profile.id,
        name: s.profile.name,
        kind: s.profile.protocol === 'serial' ? 'serial' : 'ssh'
      })
    }
    return out
  }

  /**
   * 运行联动自动化。targets 为会话 sessionId 列表（顺序即脚本中的下标 0..n-1），
   * steps 为解析后的步骤（TX/RX 带目标下标；sleep 无目标）。
   */
  runGlobalMacro(cfg: {
    targets: string[]
    steps: GlobalMacroStep[]
    loop: number
  }): { ok: boolean; error?: string } {
    if (this.gm) return { ok: false, error: '已有联动自动化在运行' }
    if (!cfg.targets || cfg.targets.length === 0) return { ok: false, error: '未选择参与会话' }
    if (!cfg.steps || cfg.steps.length === 0) return { ok: false, error: '脚本为空' }

    // 校验目标：需已连接、支持写与订阅
    const names: string[] = []
    for (let i = 0; i < cfg.targets.length; i++) {
      const s = this.sessions.get(cfg.targets[i])
      if (!s || !s.write || !s.subscribeData || s.status !== 'connected') {
        return { ok: false, error: `目标 ${i} 不可用（未连接或非 SSH/串口）` }
      }
      names.push(s.profile.name)
    }

    this.gm = {
      cancelled: false,
      targets: cfg.targets,
      names,
      loop: cfg.loop === -1 ? -1 : Math.max(1, Math.floor(cfg.loop)),
      iter: 1,
      idx: 0,
      totalSteps: cfg.steps.length,
      tails: cfg.targets.map(() => ''),
      unsubs: [],
      waitTarget: null,
      waitNeedle: null,
      waitResolve: null,
      waitTimer: null,
      sleepTimer: null,
      sleepResolve: null
    }
    const g = this.gm

    // 订阅每个目标输出文本 → 累积 tail 供 RX 匹配
    cfg.targets.forEach((sessionId, i) => {
      const s = this.sessions.get(sessionId)
      if (!s?.subscribeData) return
      g.unsubs.push(
        s.subscribeData((text: string) => {
          if (g.cancelled) return
          g.tails[i] = (g.tails[i] + text).slice(-16384)
          if (g.waitTarget === i && g.waitNeedle && g.tails[i].includes(g.waitNeedle)) {
            g.waitTarget = null
            const needle = g.waitNeedle
            g.waitNeedle = null
            if (g.waitTimer) {
              clearTimeout(g.waitTimer)
              g.waitTimer = null
            }
            const r = g.waitResolve
            g.waitResolve = null
            if (r) r(true)
            void needle
          }
        })
      )
    })

    this.emitGlobalMacro({
      running: true,
      state: 'running',
      idx: 0,
      total: cfg.steps.length,
      iter: 1,
      loop: g.loop,
      targetIndex: cfg.steps[0]?.op === 'sleep' ? undefined : cfg.steps[0]?.target,
      targetName:
        cfg.steps[0]?.op === 'sleep' ? undefined : names[cfg.steps[0]?.target ?? 0],
      op: cfg.steps[0]?.op,
      message: '开始'
    })
    void this.runGlobalLoop(cfg.steps)
    return { ok: true }
  }

  /** 停止联动自动化 */
  stopGlobalMacro(): void {
    const g = this.gm
    if (!g) return
    g.cancelled = true
    if (g.sleepTimer) clearTimeout(g.sleepTimer)
    if (g.sleepResolve) {
      const r = g.sleepResolve
      g.sleepResolve = null
      r(false)
    }
    if (g.waitTimer) {
      clearTimeout(g.waitTimer)
      g.waitTimer = null
    }
    if (g.waitResolve) {
      g.waitTarget = null
      g.waitNeedle = null
      const r = g.waitResolve
      g.waitResolve = null
      r(false)
    }
    this.cleanupGlobalMacro()
    this.emitGlobalMacro({
      running: false,
      state: 'stopped',
      idx: g.idx,
      total: g.totalSteps,
      iter: g.iter,
      loop: g.loop,
      message: '已停止'
    })
    this.gm = null
  }

  private async runGlobalLoop(steps: GlobalMacroStep[]): Promise<void> {
    const g = this.gm
    if (!g) return
    try {
      while (!g.cancelled) {
        for (let i = 0; i < steps.length && !g.cancelled; i++) {
          g.idx = i
          const st = steps[i]
          const name = st.op === 'sleep' ? undefined : g.names[st.target]
          this.emitGlobalMacro({
            running: true,
            state: 'running',
            idx: i,
            total: steps.length,
            iter: g.iter,
            loop: g.loop,
            targetIndex: st.op === 'sleep' ? undefined : st.target,
            targetName: name,
            op: st.op,
            message:
              st.op === 'tx'
                ? `发送: ${st.text ?? ''}`
                : st.op === 'rx'
                  ? `等待 ${name}: ${st.text ?? ''}`
                  : `延时 ${st.secs ?? 0}s`
          })
          if (st.op === 'tx') {
            if (st.target >= 0 && st.target < g.targets.length) {
              this.sessions.get(g.targets[st.target])?.write?.(st.text ?? '')
            }
          } else if (st.op === 'rx') {
            const ok = await this.gmWait(st.target, st.text ?? '')
            if (!ok) {
              if (g.cancelled) break
              throw new Error(
                `等待输出超时: ${g.names[st.target] ?? st.target} 需包含 "${st.text ?? ''}"`
              )
            }
          } else if (st.op === 'sleep') {
            const ok = await this.gmSleep((st.secs ?? 0) * 1000)
            if (!ok && g.cancelled) break
          }
        }
        if (g.cancelled) break
        if (g.loop === -1) g.iter++
        else if (g.iter < g.loop) g.iter++
        else break
      }
      if (!g.cancelled && this.gm === g) {
        this.emitGlobalMacro({
          running: false,
          state: 'done',
          idx: steps.length - 1,
          total: steps.length,
          iter: g.iter,
          loop: g.loop,
          message: '执行完成'
        })
      }
    } catch (e) {
      if (!g.cancelled && this.gm === g) {
        this.emitGlobalMacro({
          running: false,
          state: 'error',
          idx: g.idx,
          total: steps.length,
          iter: g.iter,
          loop: g.loop,
          message: (e as Error).message
        })
      }
    } finally {
      if (this.gm === g) {
        this.cleanupGlobalMacro()
        this.gm = null
      }
    }
  }

  private gmWait(target: number, needle: string): Promise<boolean> {
    const g = this.gm
    if (!g) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      if (target < 0 || target >= g.targets.length) {
        resolve(false)
        return
      }
      if (g.tails[target].includes(needle)) {
        resolve(true)
        return
      }
      g.waitTarget = target
      g.waitNeedle = needle
      g.waitResolve = resolve
      g.waitTimer = setTimeout(() => {
        if (g.waitResolve === resolve) {
          g.waitTarget = null
          g.waitNeedle = null
          g.waitResolve = null
          g.waitTimer = null
          resolve(false)
        }
      }, 60000)
    })
  }

  private gmSleep(ms: number): Promise<boolean> {
    const g = this.gm
    if (!g) return Promise.resolve(false)
    if (ms <= 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      g.sleepResolve = resolve
      g.sleepTimer = setTimeout(() => {
        g.sleepTimer = null
        const r = g.sleepResolve
        g.sleepResolve = null
        if (r) r(!g.cancelled)
      }, ms)
    })
  }

  private cleanupGlobalMacro(): void {
    const g = this.gm
    if (!g) return
    for (const un of g.unsubs) {
      try {
        un()
      } catch {
        /* ignore */
      }
    }
    g.unsubs = []
  }

  private emitGlobalMacro(st: GlobalMacroStatus): void {
    this.send('globalmacro:status', st)
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
