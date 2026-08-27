import { appendFileSync, existsSync, writeFileSync } from 'fs'
import os from 'node:os'
import path from 'path'
import { app, utilityProcess, UtilityProcess } from 'electron'
import { ConnectionProfile, ConnectionStatus } from '@shared/types'
import { BaseSession, SendFn } from './types'

interface RdpInputMsg {
  type: 'mouse' | 'key' | 'unicode'
  x?: number
  y?: number
  flags?: number
  scancode?: number
  code?: number
  pressed?: boolean
}

/** utility process worker 脚本路径（打包用 extraResources，开发用源码目录） */
function workerScriptPath(): string {
  const packed = path.join(process.resourcesPath, 'rdp-worker.cjs')
  if (existsSync(packed)) return packed
  return path.join(process.cwd(), 'src', 'main', 'rdp-worker.cjs')
}

/** FreeRDP addon 是否可用（供 UI 检测） */
export function isAddonAvailable(): boolean {
  const res = process.resourcesPath
  const candidates = [
    path.join(res, 'freerdp', 'freerdp.node'),
    path.join(res, 'freerdp', 'build', 'Release', 'freerdp.node'),
    path.join(process.cwd(), 'native', 'freerdp', 'build', 'Release', 'freerdp.node')
  ]
  return candidates.some((c) => {
    try {
      return existsSync(c)
    } catch {
      return false
    }
  })
}

/**
 * RDP 会话（FreeRDP 3 嵌入式方案，独立进程隔离）
 *
 * addon 在 **utility process** 中运行（src/main/rdp-worker.cjs），通过
 * process.parentPort 与主进程通信；即使 FreeRDP 连接时崩溃（如 Windows
 * 0xc0000005），只崩溃该 utility 进程，主进程与 UI 保持稳定。
 */
export class RDPSession2 implements BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus = 'connecting'
  error?: string

  private child: UtilityProcess | null = null
  private disposed = false
  /** 是否正在执行 resize 重连（等待旧 worker 退出），用于防并发 */
  private resizing = false
  private readonly send: SendFn
  /** 当前会话分辨率（由渲染进程容器尺寸驱动，重连时应用） */
  private size: { width: number; height: number } = { width: 1280, height: 720 }

  constructor(sessionId: string, profile: ConnectionProfile, send: SendFn) {
    this.sessionId = sessionId
    this.profile = profile
    this.send = send
  }

  /** 调整分辨率：更新目标尺寸；已连接则重连以应用（跟随容器铺满） */
  async resize(width: number, height: number): Promise<void> {
    if (width <= 0 || height <= 0) return
    const w = Math.round(width)
    const h = Math.round(height)
    // 尺寸未变：跳过（避免 ResizeObserver 重复上报导致反复 kill + 重连）
    if (w === this.size.width && h === this.size.height) return
    this.size = { width: w, height: h }
    const old = this.child
    this.child = null // 先断开引用，旧 worker exit 不误报状态
    if (this.resizing) return // 已有 resize 在等待退出/连接：仅更新 size（防并发）
    if (this.disposed) return // 已关闭：不重连
    if (old) {
      // 有活动 worker：等其真正退出再连接，避免新旧 worker 帧重叠导致画面错乱
      this.resizing = true
      this.setStatus('connecting', '调整分辨率…')
      try {
        await new Promise<void>((resolve) => {
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            resolve()
          }
          old.once('exit', finish)
          try {
            old.kill()
          } catch {
            finish()
          }
          setTimeout(finish, 2000) // 兜底：2s 后强制继续
        })
      } finally {
        this.resizing = false
      }
      if (this.disposed) return
    }
    // old 为 null（如切走标签期间后台 worker 已断开退出）或等退出完成 →
    // 用最新尺寸重新连接。修复"切走再回来时黑屏"（断开的会话无法自动恢复）
    await this.connect().catch(() => {
      /* 状态已通过事件上报 */
    })
  }

  async connect(): Promise<void> {
    const cfg = this.profile.rdp
    if (!cfg) {
      this.setStatus('error', '缺少 RDP 配置')
      throw new Error('缺少 RDP 配置')
    }
    const width = this.size.width
    const height = this.size.height
    const wp = workerScriptPath()
    if (!existsSync(wp)) {
      this.setStatus('error', 'RDP worker 脚本未找到（rdp-worker.cjs）')
      throw new Error('RDP worker 脚本未找到')
    }
    // Windows 上 OpenSSL 3 LEGACY provider（md4/rc4）用于 NTLM 与 RDP licensing：
    // 在 worker 进程 env 中指定模块目录 + 配置文件（进程启动即生效，早于任何
    // OpenSSL 初始化），规避 "LEGACY provider failed to load" → ERRBASE_UNKNOWN
    const freerdpRoot = path.join(process.resourcesPath, 'freerdp')
    // OPENSSL_MODULES：仅 Windows 需要——随包目录含 legacy.dll（md4/rc4 用于
    // NTLM 认证与 RDP licensing）。Linux 不设置，使用系统默认 ossl-modules
    // 目录（legacy.so 在 /usr/lib/.../ossl-modules）；指向 freerdp 目录会因
    // 没有 legacy.so 导致 legacy provider 加载失败 → NLA/TLS 协商失败。
    let opensslModules: string | undefined
    if (process.platform === 'win32') {
      opensslModules = existsSync(freerdpRoot)
        ? freerdpRoot
        : path.join(process.cwd(), 'native', 'freerdp', 'build', 'Release')
    }
    const confPath = path.join(os.tmpdir(), 'zyxterm-openssl.cnf')
    if (!existsSync(confPath)) {
      try {
        writeFileSync(
          confPath,
          [
            'openssl_conf = openssl_init', '',
            '[openssl_init]', 'providers = provider_sect', '',
            '[provider_sect]', 'default = default_sect', 'legacy = legacy_sect', '',
            '[default_sect]', 'activate = 1', '',
            '[legacy_sect]', 'activate = 1', ''
          ].join('\n'),
          'utf8'
        )
      } catch {
        /* ignore */
      }
    }
    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Linux 不设 OPENSSL_MODULES（undefined 不能作为 env 值，否则
      // utilityProcess.fork 报 "Invalid value for env"），用系统 ossl-modules
      ...(opensslModules ? { OPENSSL_MODULES: opensslModules } : {}),
      OPENSSL_CONF: confPath
    }
    // 注意：不在这里设 LD_LIBRARY_PATH 指向随包 freerdp 目录——它会全局影响
    // utility 进程（Electron）的动态库搜索，若目录内的 .so（如 libssl/libicu）
    // 与 Electron 依赖冲突会导致 utility 进程 exec 失败（退出码 32512）。
    // Linux 随包 freerdp 依赖改为在打包时用 patchelf 给 freerdp3.so 设 rpath=$ORIGIN。
    try {
      this.child = utilityProcess.fork(wp, [], {
        serviceName: 'zyxterm-rdp',
        // 收集 worker 的 stderr（含 FreeRDP WLog 详细日志）到 userData，便于排障
        stdio: ['ignore', 'pipe', 'pipe'],
        env: workerEnv
      })
    } catch (e) {
      this.setStatus('error', (e as Error).message)
      throw e
    }
    const rdpLog = path.join(app.getPath('userData'), 'rdp-worker.log')
    if (this.child.stderr) {
      this.child.stderr.on('data', (d: Buffer) => {
        try {
          appendFileSync(rdpLog, d.toString())
        } catch {
          /* ignore */
        }
      })
    }
    const worker = this.child
    worker.on('message', (e) => {
      // 只处理当前 active worker 的消息。resize()/重连替换 this.child 后，
      // 旧 worker 在终止过程中可能迟到 status disconnected 等消息，若不丢弃
      // 会覆盖新 worker 的 connected 状态 → 标签进入 disconnected 闪烁
      if (this.child !== worker) return
      this.onWorkerMessage(e)
    })
    worker.on('exit', (code) => {
      // 仅当该 worker 仍是当前 active 时才更新状态。
      // resize()/重连会替换 this.child：旧 worker 的 exit 触发时 this.child
      // 已指向新 worker，若不加守卫会误清引用 → 之后 sendInput 全丢（鼠标/
      // 键盘无反应）且 resize 重连被破坏。
      if (this.child !== worker) return
      this.child = null
      // utility 进程退出：正常断开 code=0；异常（含崩溃）code 非 0
      this.setStatus(
        code === 0 ? 'disconnected' : 'error',
        code === 0 ? '已断开' : `RDP 会话进程异常退出（代码 ${code}）`
      )
    })
    this.child.postMessage({
      cmd: 'init',
      config: {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username ?? '',
        password: cfg.password ?? '',
        domain: cfg.domain ?? '',
        width,
        height
      }
    })
  }

  sendInput(input: RdpInputMsg): void {
    this.child?.postMessage({ cmd: 'input', input })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.setStatus('disconnected')
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
    this.child = null
  }

  private onWorkerMessage(e: unknown): void {
    const msg = e as { type?: string; payload?: unknown }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
    const p = msg.payload
    switch (msg.type) {
      case 'status':
        if (p === 'connecting') this.setStatus('connecting', '正在连接…')
        else if (p === 'connected') this.setStatus('connected', '已连接')
        else if (p === 'disconnected') this.setStatus('disconnected', '已断开')
        break
      case 'error':
        this.setStatus('error', typeof p === 'string' ? p : 'RDP 错误')
        break
      case 'frame': {
        const f = p as { x?: number; y?: number; width?: number; height?: number; data?: Buffer }
        if (f && f.data) {
          this.send('rdp:frame', this.sessionId, {
            x: f.x ?? 0,
            y: f.y ?? 0,
            width: f.width ?? 0,
            height: f.height ?? 0,
            data: f.data
          })
        }
        break
      }
      case 'resize':
        this.send('rdp:resize', this.sessionId, typeof p === 'string' ? p : '')
        break
      case 'pointer': {
        const q = p as { x?: number; y?: number; width?: number; height?: number; data?: Buffer }
        if (q && q.data) {
          this.send('rdp:pointer', this.sessionId, {
            x: q.x ?? 0,
            y: q.y ?? 0,
            width: q.width ?? 0,
            height: q.height ?? 0,
            data: q.data
          })
        }
        break
      }
      default:
        break
    }
  }

  private setStatus(status: ConnectionStatus, message?: string): void {
    this.status = status
    this.error = message
    // 调试辅助：记录状态变化（不含敏感信息），便于排查连接/闪烁问题
    try {
      appendFileSync(
        path.join(app.getPath('userData'), 'rdp-status.log'),
        `[${new Date().toISOString()}] ${this.sessionId} → ${status}${
          message ? ' ' + message : ''
        }\n`
      )
    } catch {
      /* ignore */
    }
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
