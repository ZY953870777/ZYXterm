import fs from 'fs'
import { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import {
  ConnectionProfile,
  ConnectionStatus,
  SSHProfile,
  SshDirEntry
} from '@shared/types'
import { BaseSession, SendFn } from './types'

const MARK_START = '\x01ZYTPWD\x02'
const MARK_END = '\x01ZYTEND\x02'

/** POSIX 路径归一化 */
function normalizePosix(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** 解析 `cd [path]` 形式的命令 */
function parseCdCommand(cmd: string): { arg?: string } | null {
  const t = cmd.trim()
  if (t === 'cd' || t === 'cd ~') return { arg: '~' }
  const m = t.match(/^cd\s+(\S+)\s*$/)
  return m ? { arg: m[1] } : null
}

/** 基于当前目录与 home 解析 cd 目标（支持 `cd -` 回到上一目录） */
function resolveCd(
  current: string,
  arg: string | undefined,
  home: string,
  oldPwd?: string | null
): string {
  if (arg === '-') return oldPwd || current
  if (!arg || arg === '~') return home || '/'
  if (arg.startsWith('~/')) return normalizePosix(home + '/' + arg.slice(2))
  if (arg.startsWith('/')) return normalizePosix(arg)
  return normalizePosix(current + '/' + arg)
}

/** 单引号包裹 shell 参数 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 解析 `ls -la` 输出（宽松，兼容不同 locale 的日期/列格式） */
function parseLs(stdout: string): SshDirEntry[] {
  const entries: SshDirEntry[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('total')) continue
    const first = t[0]
    if (first !== '-' && first !== 'd' && first !== 'l') continue
    const parts = t.split(/\s+/)
    if (parts.length < 7) continue
    const type = first === 'd' ? 'dir' : first === 'l' ? 'link' : 'file'
    const name = parts[parts.length - 1]
    const size = parseInt(parts[4], 10) || 0
    const mtime = parts.slice(5, parts.length - 1).join(' ')
    entries.push({ name, type, size, mtime })
  }
  return entries
}

/**
 * SSH 会话
 * 通过 ssh2 建立连接，使用 shell channel 直接对接渲染进程的 xterm.js。
 * 扩展：跟踪当前工作目录（cwd），支持文件树浏览 / 手动切换 / 命令解析同步。
 */
export class SSHSession implements BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus = 'connecting'
  error?: string

  private client: Client | null = null
  private stream: ClientChannel | null = null
  private sftp: SFTPWrapper | null = null
  private readonly send: SendFn
  private cwd: string | null = null
  private oldPwd: string | null = null
  private home = '/'
  private cwdWaiters: Array<(cwd: string) => void> = []
  private outBuf = ''
  private pendingMarkTime = 0
  /** 联动自动化 RX 订阅者 */
  private dataListeners = new Set<(text: string) => void>()

  constructor(sessionId: string, profile: ConnectionProfile, send: SendFn) {
    this.sessionId = sessionId
    this.profile = profile
    this.send = send
  }

  async connect(): Promise<void> {
    const cfg = this.profile.ssh
    if (!cfg) {
      this.setStatus('error', '缺少 SSH 连接配置')
      throw new Error('缺少 SSH 连接配置')
    }
    // 自动重试：shell 建立偶发不触发回调 / 网络抖动时，服务器可达即可重试连上，
    // 避免长时间停留在 connecting（界面一直闪烁）
    const maxAttempts = 3
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.tryConnect(cfg)
        return
      } catch (e) {
        lastErr = e as Error
        if (attempt < maxAttempts - 1) {
          this.setStatus('connecting', `连接失败，正在重试（${attempt + 2}/${maxAttempts}）…`)
          await new Promise((r) => setTimeout(r, 800))
        }
      }
    }
    this.setStatus('error', lastErr?.message ?? 'SSH 连接失败')
    throw lastErr ?? new Error('SSH 连接失败')
  }

  /** 单次连接尝试（含整体超时，shell 回调偶发不触发时不会永久卡住） */
  private tryConnect(cfg: SSHProfile): Promise<void> {
    const client = new Client()
    this.client = client
    const connConfig: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3
    }
    if (cfg.authType === 'password') {
      connConfig.password = cfg.password
    } else if (cfg.authType === 'privateKey') {
      try {
        connConfig.privateKey = fs.readFileSync(cfg.privateKeyPath)
        if (cfg.passphrase) connConfig.passphrase = cfg.passphrase
      } catch (e) {
        return Promise.reject(e as Error)
      }
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          /* ignore */
        }
        reject(new Error('SSH 连接超时'))
      }, 20000)
      const done = (err?: Error): void => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          if (err) {
            try {
              client.end()
            } catch {
              /* ignore */
            }
            reject(err)
          } else {
            resolve()
          }
        }
      }

      client.once('ready', () => {
        // 通过 exec 启动交互式 bash，并在启动前设置 PROMPT_COMMAND（cwd 跟踪标记）。
        // 命令参数经 SSH exec channel 传递、不进入终端输入流，因此不会在终端回显，
        // 从而隐藏原先通过 stream.write 设置的 export PROMPT_COMMAND=... 命令。
        const ptyCmd =
          "export PROMPT_COMMAND='printf \"\\x01ZYTPWD\\x02\";pwd;printf \"\\x01ZYTEND\\x02\";'; exec bash -i"
        client.exec(ptyCmd, { pty: { term: 'xterm-256color', cols: 120, rows: 30 } }, (err, stream) => {
          if (err) {
            done(err)
            return
          }
          this.stream = stream
          stream.on('data', (data: Buffer) => this.onData(data))
          stream.on('close', () => {
            this.setStatus('disconnected', 'SSH 会话已关闭')
          })
          stream.on('error', (e: Error) => {
            this.setStatus('error', e.message)
          })
          this.setStatus('connected')
          done()
          // 连接成功后自动执行用户自定义命令（稍等 shell 提示符就绪后再回车执行）
          const startup = (cfg.startupCommand ?? '').trim()
          if (startup) {
            setTimeout(() => {
              if (this.stream && !this.stream.destroyed) {
                this.stream.write(startup + '\r')
              }
            }, 600)
          }
          void this.initCwd()
        })
      })

      client.on('error', (err: Error) => {
        done(err)
      })

      client.on('close', () => {
        // 仅在连接成功后才标记断开；连接失败/重试时旧连接的 close 不干扰状态
        if (this.stream && this.status !== 'error' && this.status !== 'disconnected') {
          this.setStatus('disconnected', 'SSH 连接已关闭')
        }
      })

      client.connect(connConfig)
    })
  }

  write(data: string): void {
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(data)
    }
  }

  /** 订阅解码后的 shell 输出（联动自动化 RX 匹配用） */
  subscribeData(cb: (text: string) => void): () => void {
    this.dataListeners.add(cb)
    return () => {
      this.dataListeners.delete(cb)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.stream && !this.stream.destroyed) {
      this.stream.setWindow(rows, cols, 0, 0)
    }
  }

  async dispose(): Promise<void> {
    this.setStatus('disconnected')
    try {
      this.stream?.close()
      this.sftp?.end()
      this.client?.end()
    } catch {
      /* ignore */
    }
    this.client = null
    this.stream = null
    this.sftp = null
  }

  // ---------- 目录 / 文件树 ----------

  /** 执行一次性命令（独立 exec channel，不污染主 shell 输出） */
  private exec(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('SSH 未连接'))
        return
      }
      // 命令执行超时：避免回调偶发不触发导致永久 pending（文件树“读取中”卡住）
      const timer = setTimeout(
        () => reject(new Error('命令执行超时')),
        15000
      )
      this.client.exec(cmd, (err, ch) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }
        let out = ''
        let errOut = ''
        ch.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        ch.stderr.on('data', (d: Buffer) => {
          errOut += d.toString('utf8')
        })
        ch.on('close', () => {
          clearTimeout(timer)
          resolve({ stdout: out, stderr: errOut })
        })
        ch.on('error', (e: Error) => {
          clearTimeout(timer)
          reject(e)
        })
      })
    })
  }

  private async initCwd(): Promise<void> {
    try {
      const pwd = await this.exec('pwd')
      const home = await this.exec('echo $HOME')
      this.cwd = pwd.stdout.trim() || '/'
      this.home = home.stdout.trim() || this.cwd
      this.send('ssh:cwd-changed', this.sessionId, this.cwd)
    } catch {
      /* ignore */
    }
  }

  /** 向主 shell 注入 pwd 标记命令并解析（用于确认目录 / 手动刷新） */
  private syncCwd(): Promise<string> {
    return new Promise((resolve) => {
      this.cwdWaiters.push(resolve)
      this.write(`printf '${MARK_START}'; pwd; printf '${MARK_END}\n'`)
      setTimeout(() => {
        const i = this.cwdWaiters.indexOf(resolve)
        if (i >= 0) this.cwdWaiters.splice(i, 1)
        resolve(this.cwd ?? '')
      }, 2000)
    })
  }

  /** shell 输出处理：提取 pwd 标记段并过滤，其余转发给终端 */
  private onData(data: Buffer): void {
    this.outBuf += data.toString('utf8')
    let out = ''
    while (this.outBuf.length > 0) {
      const start = this.outBuf.indexOf(MARK_START)
      if (start < 0) {
        out += this.outBuf
        this.outBuf = ''
        break
      }
      out += this.outBuf.slice(0, start)
      const end = this.outBuf.indexOf(MARK_END, start)
      if (end < 0) {
        // 标记未完整：加超时保护，避免正常输出恰含标记开头序列时
        // 一直等待结束标记而吞掉输出（导致终端卡住）
        const now = Date.now()
        if (this.pendingMarkTime === 0) this.pendingMarkTime = now
        if (now - this.pendingMarkTime > 800) {
          out += this.outBuf
          this.outBuf = ''
          this.pendingMarkTime = 0
          break
        }
        this.outBuf = this.outBuf.slice(start)
        break
      }
      const cwd = this.outBuf.slice(start + MARK_START.length, end).trim()
      this.cwd = cwd
      const waiters = this.cwdWaiters
      this.cwdWaiters = []
      waiters.forEach((r) => r(cwd))
      this.send('ssh:cwd-changed', this.sessionId, cwd)
      this.outBuf = this.outBuf.slice(end + MARK_END.length)
      this.pendingMarkTime = 0
    }
    if (out) {
      this.send('terminal:data', this.sessionId, out)
      for (const cb of this.dataListeners) {
        try {
          cb(out)
        } catch {
          /* ignore */
        }
      }
    }
  }

  getCwd(): string | null {
    return this.cwd
  }

  // ---------- SFTP 文件传输 ----------

  private ensureSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp)
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('SSH 未连接'))
        return
      }
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err)
          return
        }
        this.sftp = sftp
        sftp.on('close', () => {
          this.sftp = null
        })
        resolve(sftp)
      })
    })
  }

  /** 下载远端文件内容（供保存到本地） */
  async downloadFile(remotePath: string): Promise<Buffer> {
    const sftp = await this.ensureSftp()
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => (err ? reject(err) : resolve(data)))
    })
  }

  /** 上传本地内容到远端路径 */
  async uploadFile(remotePath: string, data: Buffer): Promise<void> {
    const sftp = await this.ensureSftp()
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, data, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** 浏览指定目录（不改变主 shell 目录），默认当前目录 */
  async listDir(
    path?: string
  ): Promise<{ cwd: string; entries: SshDirEntry[]; error?: string }> {
    const target = path ?? this.cwd ?? '/'
    try {
      const { stdout, stderr } = await this.exec(
        `cd ${shellQuote(target)} && ls -la 2>&1`
      )
      const entries = parseLs(stdout || stderr)
      return { cwd: target, entries }
    } catch (e) {
      return { cwd: target, entries: [], error: (e as Error).message }
    }
  }

  /** 手动切换目录：向主 shell 写入 cd 并更新 cwd */
  async cd(path: string): Promise<{ cwd: string; entries: SshDirEntry[] }> {
    const target = resolveCd(this.cwd ?? '/', path, this.home, this.oldPwd)
    this.write(`cd ${shellQuote(target)}\n`)
    if (this.cwd !== target) this.oldPwd = this.cwd
    this.cwd = target
    this.send('ssh:cwd-changed', this.sessionId, this.cwd)
    const { entries } = await this.listDir(target)
    return { cwd: this.cwd, entries }
  }

  /** 用户在主终端提交命令：解析 cd 更新 cwd（含 cd - 回上一目录） */
  handleCommand(cmd: string): void {
    const parsed = parseCdCommand(cmd)
    if (parsed) {
      const target = resolveCd(this.cwd ?? '/', parsed.arg, this.home, this.oldPwd)
      if (this.cwd !== target) this.oldPwd = this.cwd
      this.cwd = target
      this.send('ssh:cwd-changed', this.sessionId, this.cwd)
    } else if (/^cd\s+/.test(cmd.trim())) {
      // 含 cd 但无法简单解析（变量/多命令等），注入标记确认实际目录
      void this.syncCwd()
    }
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
