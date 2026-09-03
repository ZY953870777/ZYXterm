import net from 'net'
import path from 'path'
import { createWriteStream, promises as fsp, WriteStream } from 'fs'
import {
  ConnectionProfile,
  ConnectionStatus,
  SerialMacroStatus,
  SerialMacroStep,
  XmodemStatus
} from '@shared/types'
import { buildSetup, encodeData, Rfc2217Decoder } from '../rfc2217'
import { getSerialPortModule, SerialPortInstance } from '../serialport-loader'
import { XmodemReceiver, XmodemSender } from '../xmodem'
import { BaseSession, SendFn } from './types'

/** 自动化步骤的简要描述（状态里显示用） */
function macroStepDesc(s: SerialMacroStep): string {
  if (s.op === 'tx')
    return '发送: ' + (s.text ?? '').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
  if (s.op === 'rx') return '等待: ' + (s.text ?? '')
  return '延时 ' + (s.secs ?? 0) + 's'
}

/**
 * 串口会话
 *
 * 两种连接模式（SerialProfile.mode）：
 * - local（默认）：本机串口，serialport 直接模式——渲染进程 xterm 输入直接写入
 *   串口，串口数据直接回显到终端（不做本地 PTY 桥接）
 * - tcp：网络串口——用 net.Socket 连接设备端串口转发服务（ser2net/socat），
 *   数据双向收发，规避设备端串口的 OS 排他（多个用户可各自连同一转发端口）
 *
 * XMODEM 文件传输：基于同一双向字节流承载（local / tcp / RFC2217 均可）。
 * 传输期间原始字节流被收发状态机接管（不再回显终端），结束后恢复普通显示。
 */
export class SerialSession implements BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus = 'connecting'
  error?: string

  private port: SerialPortInstance | null = null
  private socket: net.Socket | null = null
  private rfc2217 = false
  private readonly send: SendFn

  // XMODEM 传输状态
  private xmodemMode: 'idle' | 'send' | 'recv' = 'idle'
  private xmodemSender: XmodemSender | null = null
  private xmodemReceiver: XmodemReceiver | null = null

  // 实时日志（接收数据追加写入用户指定文件）
  private logStream: WriteStream | null = null
  private logPath: string | null = null

  // 串口自动化脚本（TX/RX/SLEEP）运行状态
  private macro: {
    steps: SerialMacroStep[]
    loop: number // -1 = 无限
    idx: number
    iter: number
    cancelled: boolean
    tail: string
    waitNeedle: string | null
    waitResolve: (() => void) | null
    sleepTimer: ReturnType<typeof setTimeout> | null
    sleepResolve: (() => void) | null
  } | null = null

  constructor(sessionId: string, profile: ConnectionProfile, send: SendFn) {
    this.sessionId = sessionId
    this.profile = profile
    this.send = send
  }

  connect(): Promise<void> {
    const cfg = this.profile.serial
    if (!cfg) {
      this.setStatus('error', '缺少串口配置')
      return Promise.reject(new Error('缺少串口配置'))
    }

    // ---------- 网络串口（TCP）：net.Socket 直连 ----------
    if (cfg.mode === 'tcp') {
      const host = cfg.host || '127.0.0.1'
      const port = cfg.port || 0
      if (!port) {
        const msg = '缺少网络串口端口'
        this.setStatus('error', msg)
        return Promise.reject(new Error(msg))
      }
      // RFC2217：连接后向 ser2net 下发波特率/数据位/校验/停止位/流控（动态调参）
      const useRfc2217 = cfg.rfc2217 === true
      const rfcDecoder = useRfc2217 ? new Rfc2217Decoder() : null
      this.rfc2217 = useRfc2217
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const socket = net.createConnection({ host, port })
        this.socket = socket

        socket.on('data', (data: Buffer) => {
          // RFC2217：先剥离 Telnet 协议字节，再按 XMODEM/终端分流
          const out = rfcDecoder ? rfcDecoder.decode(data) : data
          if (out.length > 0) this.handleIncoming(out)
        })
        socket.on('error', (e: Error) => {
          this.abortXmodem()
          this.setStatus('error', e.message)
          if (!settled) {
            settled = true
            reject(e)
          }
        })
        socket.on('close', () => {
          this.abortXmodem()
          this.setStatus('disconnected', '连接已关闭')
        })
        socket.on('connect', () => {
          if (useRfc2217) {
            socket.write(
              buildSetup({
                baudRate: cfg.baudRate,
                dataBits: cfg.dataBits,
                parity: cfg.parity,
                stopBits: cfg.stopBits,
                flowControl: cfg.flowControl
              })
            )
          }
          this.setStatus('connected')
          if (!settled) {
            settled = true
            resolve()
          }
        })
      })
    }

    // ---------- 本机串口：serialport 直接模式 ----------
    // 原生串口模块不可用时优雅降级（如 Docker 交叉打包的 Windows 包）
    const { mod, error } = getSerialPortModule()
    if (!mod) {
      const msg = `串口模块不可用：${error ?? '未知原因'}\n（Docker 交叉打包的 Windows 包不含 Windows 原生串口模块；如需完整串口功能，请使用 Windows 环境执行 npm run dist:win 打包）`
      this.setStatus('error', msg)
      return Promise.reject(new Error(msg))
    }
    const SerialPort = mod.SerialPort

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const port = new SerialPort({
        path: cfg.path,
        baudRate: cfg.baudRate,
        dataBits: cfg.dataBits,
        stopBits: cfg.stopBits,
        parity: cfg.parity,
        flowControl:
          cfg.flowControl === 'hardware'
            ? 'hardware'
            : cfg.flowControl === 'software'
              ? 'software'
              : false,
        autoOpen: false
      })
      this.port = port

      port.on('data', (data: Buffer) => {
        this.handleIncoming(data)
      })

      port.on('error', (e: Error) => {
        this.abortXmodem()
        this.setStatus('error', e.message)
        if (!settled) {
          settled = true
          reject(e)
        }
      })

      port.on('close', () => {
        this.abortXmodem()
        this.setStatus('disconnected', '串口已关闭')
      })

      port.open((err) => {
        if (err) {
          this.setStatus('error', err.message)
          if (!settled) {
            settled = true
            reject(err)
          }
          return
        }
        this.setStatus('connected')
        if (!settled) {
          settled = true
          resolve()
        }
      })
    })
  }

  write(data: string): void {
    this.rawWrite(Buffer.from(data, 'utf8'))
  }

  // 串口无终端尺寸概念
  resize(): void {
    /* no-op */
  }

  async dispose(): Promise<void> {
    this.abortXmodem()
    this.logStop()
    this.macroStop()
    this.setStatus('disconnected')
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    try {
      if (this.port && this.port.isOpen) this.port.close()
    } catch {
      /* ignore */
    }
    this.port = null
  }

  // ================= XMODEM 文件传输 =================

  /** 发送本地文件（XMODEM）。对端需先进入接收态（如 Linux 上执行 rx/sb -k） */
  xmodemSend(filePath: string): { ok: boolean; error?: string } {
    if (!this.isWritable()) return { ok: false, error: '串口未连接' }
    if (this.xmodemMode !== 'idle') return { ok: false, error: '已有 XMODEM 传输在进行中' }
    void this.startSend(filePath)
    return { ok: true }
  }

  /** 接收文件到 savePath（XMODEM）。对端需先执行发送命令（如 sz -k 文件名） */
  xmodemReceive(savePath: string): { ok: boolean; error?: string } {
    if (!this.isWritable()) return { ok: false, error: '串口未连接' }
    if (this.xmodemMode !== 'idle') return { ok: false, error: '已有 XMODEM 传输在进行中' }
    const name = path.basename(savePath)
    this.xmodemMode = 'recv'
    this.emitXmodem({ state: 'started', mode: 'recv', name, savePath })
    this.termLine(`XMODEM 接收：${name}。请在设备端执行发送命令（sz -k 文件名）`)
    const receiver = new XmodemReceiver({
      write: (b) => this.rawWrite(b),
      onProgress: (sent, totalBytes) =>
        this.emitXmodem({ state: 'progress', mode: 'recv', sent, total: totalBytes, name }),
      onChunk: (full) => {
        this.emitXmodem({
          state: 'progress',
          mode: 'recv',
          sent: full.length,
          total: full.length,
          name
        })
        void fsp.writeFile(savePath, full).catch((e: Error) => {
          this.emitXmodem({
            state: 'error',
            mode: 'recv',
            message: '写入文件失败：' + e.message,
            name
          })
        })
      },
      onDone: (err) => {
        this.finishXmodem('recv', err, savePath)
      }
    })
    this.xmodemReceiver = receiver
    receiver.start()
    return { ok: true }
  }

  /** 取消进行中的 XMODEM 传输（向对端发 CAN 中断） */
  cancelXmodem(): void {
    this.abortXmodem()
  }

  // ================= 串口实时日志 =================

  /** 开始把串口接收数据实时追加写入 filePath（可重复调用：已在记录时忽略） */
  logStart(filePath: string): { ok: boolean; error?: string } {
    if (this.logStream) return { ok: false, error: '日志已在记录中' }
    if (!this.isWritable()) return { ok: false, error: '串口未连接' }
    try {
      const stream = createWriteStream(filePath, { flags: 'a', encoding: undefined })
      // 异步写失败（如磁盘满/权限变化）：停止记录并通知界面
      stream.on('error', (e: Error) => {
        const wasLogging = !!this.logStream
        this.stopLogSilently()
        if (wasLogging) this.emitLogStatus(false, undefined)
        this.send('terminal:data', this.sessionId, '\r\n[串口日志] 写入失败：' + e.message + '\r\n')
      })
      stream.on('open', () => {
        this.termLine(`串口日志已开启：${filePath}（实时追加）`)
      })
      this.logStream = stream
      this.logPath = filePath
      this.emitLogStatus(true, filePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** 停止日志记录（幂等） */
  logStop(): void {
    if (!this.logStream) return
    const p = this.logPath
    this.stopLogSilently()
    this.emitLogStatus(false, undefined)
    this.termLine(p ? `串口日志已停止：${p}` : '串口日志已停止')
  }

  /** 当前日志状态（供渲染层同步界面） */
  logState(): { logging: boolean; path?: string } {
    return this.logStream
      ? { logging: true, path: this.logPath ?? undefined }
      : { logging: false }
  }

  /** 广播日志状态（channel: serial:log-status） */
  private emitLogStatus(logging: boolean, path: string | undefined): void {
    this.send('serial:log-status', this.sessionId, { logging, path })
  }

  /** 静默关闭流（不广播，供 error 分支复用） */
  private stopLogSilently(): void {
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch {
        /* ignore */
      }
      this.logStream = null
    }
    this.logPath = null
  }

  // ================= 串口自动化（TX / RX / SLEEP 脚本） =================

  /** 开始执行自动化脚本。steps 为解析后的步骤；loop=-1 无限 */
  macroStart(run: { steps: SerialMacroStep[]; loop: number }): { ok: boolean; error?: string } {
    if (!this.isWritable()) return { ok: false, error: '串口未连接' }
    if (this.macro) return { ok: false, error: '已有自动化脚本在运行' }
    if (!run.steps || run.steps.length === 0) return { ok: false, error: '脚本为空' }
    this.macro = {
      steps: run.steps,
      loop: run.loop === -1 ? -1 : Math.max(1, Math.floor(run.loop)),
      idx: 0,
      iter: 1,
      cancelled: false,
      tail: '',
      waitNeedle: null,
      waitResolve: null,
      sleepTimer: null,
      sleepResolve: null
    }
    this.emitMacro({
      running: true,
      state: 'running',
      idx: 0,
      total: run.steps.length,
      iter: 1,
      loop: this.macro.loop,
      op: run.steps[0]?.op,
      message: '开始'
    })
    void this.runMacro()
    return { ok: true }
  }

  /** 停止运行中的脚本 */
  macroStop(): void {
    const m = this.macro
    if (!m) return
    m.cancelled = true
    if (m.sleepTimer) {
      clearTimeout(m.sleepTimer)
      m.sleepTimer = null
    }
    if (m.sleepResolve) {
      const r = m.sleepResolve
      m.sleepResolve = null
      r()
    }
    if (m.waitResolve) {
      const r = m.waitResolve
      m.waitResolve = null
      r()
    }
    this.emitMacro({
      running: false,
      state: 'stopped',
      idx: m.idx,
      total: m.steps.length,
      iter: m.iter,
      loop: m.loop,
      message: '已停止'
    })
    this.macro = null
  }

  private async runMacro(): Promise<void> {
    const m = this.macro
    if (!m) return
    try {
      while (!m.cancelled) {
        for (let i = 0; i < m.steps.length && !m.cancelled; i++) {
          m.idx = i
          const step = m.steps[i]
          this.emitMacro({
            running: true,
            state: 'running',
            idx: i,
            total: m.steps.length,
            iter: m.iter,
            loop: m.loop,
            op: step.op,
            message: macroStepDesc(step)
          })
          if (step.op === 'tx') {
            this.rawWrite(Buffer.from(step.text ?? '', 'utf8'))
          } else if (step.op === 'rx') {
            await this.waitMacroRx(step.text ?? '')
          } else if (step.op === 'sleep') {
            await this.macroSleep((step.secs ?? 0) * 1000)
          }
        }
        if (m.cancelled) break
        if (m.loop === -1) m.iter++
        else if (m.iter < m.loop) m.iter++
        else break
      }
      if (!m.cancelled && this.macro === m) {
        this.emitMacro({
          running: false,
          state: 'done',
          idx: m.steps.length - 1,
          total: m.steps.length,
          iter: m.iter,
          loop: m.loop,
          message: '执行完成'
        })
        this.termLine('自动化脚本执行完成')
      }
    } catch (e) {
      this.emitMacro({
        running: false,
        state: 'error',
        idx: m.idx,
        total: m.steps.length,
        iter: m.iter,
        loop: m.loop,
        message: (e as Error).message
      })
      this.termLine('自动化脚本执行失败：' + (e as Error).message)
    } finally {
      if (this.macro === m) this.macro = null
    }
  }

  private waitMacroRx(needle: string): Promise<void> {
    const m = this.macro
    if (!m) return Promise.resolve()
    return new Promise<void>((resolve) => {
      m.waitNeedle = needle
      m.waitResolve = resolve
      this.resolveMacroRx()
    })
  }

  /** 把收到的文本喂给 rx 匹配；命中则放行 */
  private resolveMacroRx(): void {
    const m = this.macro
    if (!m || !m.waitResolve || !m.waitNeedle) return
    if (m.tail.includes(m.waitNeedle)) {
      const r = m.waitResolve
      m.waitResolve = null
      m.waitNeedle = null
      r()
    }
  }

  private macroSleep(ms: number): Promise<void> {
    const m = this.macro
    if (!m) return Promise.resolve()
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      m.sleepResolve = resolve
      m.sleepTimer = setTimeout(() => {
        m.sleepTimer = null
        const r = m.sleepResolve
        m.sleepResolve = null
        if (r) r()
      }, ms)
    })
  }

  private emitMacro(st: SerialMacroStatus): void {
    this.send('serial:macro-status', this.sessionId, st)
  }

  private async startSend(filePath: string): Promise<void> {
    let data: Buffer
    try {
      data = await fsp.readFile(filePath)
    } catch (e) {
      this.emitXmodem({ state: 'error', mode: 'send', message: '读取文件失败：' + (e as Error).message })
      return
    }
    // 读取文件期间被取消/断开：放弃本次发送
    if (this.xmodemMode !== 'idle' || !this.isWritable()) return
    const name = path.basename(filePath)
    const total = data.length
    this.xmodemMode = 'send'
    this.emitXmodem({ state: 'started', mode: 'send', name, total })
    this.termLine(`XMODEM 发送：${name}（${total} 字节）。请在设备端执行接收命令（rx/sb -k）`)
    const sender = new XmodemSender(data, {
      write: (b) => this.rawWrite(b),
      onProgress: (sent, totalBytes) =>
        this.emitXmodem({ state: 'progress', mode: 'send', sent, total: totalBytes, name }),
      onDone: (err) => {
        this.finishXmodem('send', err, undefined, total)
      }
    })
    this.xmodemSender = sender
    sender.start()
  }

  /** 传输结束统一收尾：广播结果并复位状态 */
  private finishXmodem(
    mode: 'send' | 'recv',
    err: string | undefined,
    savePath?: string,
    total?: number
  ): void {
    if (err) {
      if (err === '已取消') {
        this.emitXmodem({ state: 'cancel', mode })
        this.termLine('XMODEM 传输已取消')
      } else {
        this.emitXmodem({ state: 'error', mode, message: err })
        this.termLine(`XMODEM 传输失败：${err}`)
      }
    } else {
      this.emitXmodem({ state: 'done', mode, total, savePath })
      this.termLine(
        savePath
          ? `XMODEM 接收完成：${savePath}`
          : `XMODEM 发送完成（${total ?? 0} 字节）`
      )
    }
    this.resetXmodem()
  }

  /** 底层写原始字节（RFC2217 时按 Telnet 转义，保证二进制透传） */
  private rawWrite(data: Buffer): void {
    if (this.socket && this.socket.writable) {
      this.socket.write(this.rfc2217 ? encodeData(data) : data)
    } else if (this.port && this.port.isOpen) {
      this.port.write(data)
    }
  }

  /** 统一接收处理：XMODEM 传输中字节交给状态机，否则回显为终端文本 */
  private handleIncoming(data: Buffer): void {
    if (this.xmodemMode === 'send' && this.xmodemSender) {
      for (const b of data) this.xmodemSender.feed(b)
      return
    }
    if (this.xmodemMode === 'recv' && this.xmodemReceiver) {
      this.xmodemReceiver.feed(data)
      return
    }
    // 自动化脚本：持续累积最近输出供 rx 匹配
    if (this.macro && !this.macro.cancelled) {
      this.macro.tail += data.toString('utf8')
      if (this.macro.tail.length > 8192) this.macro.tail = this.macro.tail.slice(-8192)
      this.resolveMacroRx()
    }
    // 实时日志：把串口收到的原始字节实时写入日志文件（追加模式）
    if (this.logStream && this.logStream.writable) {
      try {
        this.logStream.write(data)
      } catch {
        /* 写失败不阻塞串口数据流 */
      }
    }
    this.send('terminal:data', this.sessionId, data.toString('utf8'))
  }

  private emitXmodem(st: XmodemStatus): void {
    this.send('serial:xmodem-status', this.sessionId, st)
  }

  /** 向终端打印一行状态提示（换行包裹，避免粘连） */
  private termLine(msg: string): void {
    this.send('terminal:data', this.sessionId, '\r\n' + msg + '\r\n')
  }

  private resetXmodem(): void {
    this.xmodemSender = null
    this.xmodemReceiver = null
    this.xmodemMode = 'idle'
  }

  /** 中止当前传输（若有）并复位。abort 会发 CAN 并触发 onDone 收尾 */
  private abortXmodem(): void {
    if (this.xmodemMode === 'send') this.xmodemSender?.abort()
    else if (this.xmodemMode === 'recv') this.xmodemReceiver?.abort()
    else this.resetXmodem()
  }

  private isWritable(): boolean {
    return !!(this.socket && this.socket.writable) || !!(this.port && this.port.isOpen)
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
      message
    })
  }
}
