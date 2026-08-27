import { ConnectionProfile, ConnectionStatus } from '@shared/types'
import { getSerialPortModule, SerialPortInstance } from '../serialport-loader'
import { BaseSession, SendFn } from './types'

/**
 * 串口会话
 * 使用 serialport 直接模式：渲染进程 xterm 输入直接写入串口，
 * 串口读取到的数据直接回显到终端（不做本地 PTY 桥接）。
 */
export class SerialSession implements BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus = 'connecting'
  error?: string

  private port: SerialPortInstance | null = null
  private readonly send: SendFn

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
        this.send('terminal:data', this.sessionId, data.toString('utf8'))
      })

      port.on('error', (e: Error) => {
        this.setStatus('error', e.message)
        if (!settled) {
          settled = true
          reject(e)
        }
      })

      port.on('close', () => {
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
    if (this.port && this.port.isOpen) {
      this.port.write(data)
    }
  }

  // 串口无终端尺寸概念
  resize(): void {
    /* no-op */
  }

  async dispose(): Promise<void> {
    this.setStatus('disconnected')
    try {
      if (this.port && this.port.isOpen) this.port.close()
    } catch {
      /* ignore */
    }
    this.port = null
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
