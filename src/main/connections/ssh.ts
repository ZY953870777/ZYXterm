import fs from 'fs'
import os from 'os'
import path from 'path'
import { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import type { Stats } from 'ssh2'
import {
  ConnectionProfile,
  ConnectionStatus,
  SSHProfile,
  SshDirEntry
} from '@shared/types'
import { BaseSession, SendFn } from './types'

/** OSC 7（shell 集成标准序列）：file://host/path，BEL 或 ST 结束 */
const OSC7_RE = /\x1b\]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/

/** 诊断日志：ZYXTERM_DEBUG=1 启动时记录 SSH 输出流处理过程，便于定位丢输出问题 */
const DEBUG = !!process.env.ZYXTERM_DEBUG
const DEBUG_LOG = path.join(os.tmpdir(), 'zyxterm-ssh.log')
function dbg(msg: string): void {
  if (!DEBUG) return
  try {
    fs.appendFileSync(DEBUG_LOG, `${Date.now()} ${msg}\n`)
  } catch {
    /* ignore */
  }
}

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
  /** 输出缓冲：仅用于拼接跨 TCP 分片的 OSC 7 序列 */
  private outBuf = ''
  /** 待从输出流中剥离的注入命令回显（PTY 会回显输入，需在输出端过滤） */
  private pendingEcho = ''
  private echoHold = 0
  private echoStripped = 0
  private echoSeen = 0
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
      dbg(`connect ${cfg.host}:${cfg.port} attempt start`)
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
        dbg('client ready')
        // 使用真正的 shell channel（交互式登录）：sshd 会输出 motd / Last login 等登录信息，
        // 这些在 exec channel 上是看不到的。
        client.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
          if (err) {
            dbg(`shell error: ${err.message}`)
            done(err)
            return
          }
          dbg('shell channel opened')
          this.stream = stream
          stream.on('data', (data: Buffer) => this.onData(data))
          // 扩展数据（stderr）：pty 会话通常合并进主输出，无 pty/pam 阶段输出
          // 可能走扩展通道，一并转发避免丢登录信息
          stream.stderr?.on('data', (data: Buffer) => {
            dbg(`stderr len=${data.length} raw=${JSON.stringify(data.toString('utf8').slice(0, 160))}`)
            this.onData(data)
          })
          stream.on('close', () => {
            this.setStatus('disconnected', 'SSH 会话已关闭')
          })
          stream.on('error', (e: Error) => {
            this.setStatus('error', e.message)
          })
          this.setStatus('connected')
          done()
          // 每次提示符前通过 OSC 7 上报 cwd（iTerm2/VS Code 等采用的标准 shell 集成方式）
          void this.injectOsc7Hook()
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

      // SSH 认证前 banner（/etc/issue.net 等），在 shell 数据之前送达终端
      client.on('banner', (msg: string) => {
        dbg(`banner: ${JSON.stringify(msg.slice(0, 120))}`)
        this.send('terminal:data', this.sessionId, msg + '\r\n')
      })

      client.on('error', (err: Error) => {
        dbg(`client error: ${err.message}`)
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

  /** 向主 shell 注入 OSC 7 上报命令（用于确认目录 / 手动刷新） */
  private syncCwd(): Promise<string> {
    return new Promise((resolve) => {
      this.cwdWaiters.push(resolve)
      this.write(
        `printf '\\033]7;file://%s%s\\a' "$(hostname)" "$PWD"\n`
      )
      setTimeout(() => {
        const i = this.cwdWaiters.indexOf(resolve)
        if (i >= 0) this.cwdWaiters.splice(i, 1)
        resolve(this.cwd ?? '')
      }, 2000)
    })
  }

  /** 检测登录 shell 类型并注入 OSC 7 上报钩子（bash/zsh/fish），回显在输出端剥离 */
  private async injectOsc7Hook(): Promise<void> {
    let shell = ''
    try {
      shell = (await this.exec('echo $SHELL')).stdout.trim()
    } catch {
      /* 检测失败按 bash 处理 */
    }
    let snippet: string
    if (shell.includes('zsh')) {
      snippet =
        "autoload -Uz add-zsh-hook; __zy_osc7() { printf '\\033]7;file://%s%s\\a' \"$(hostname)\" \"$PWD\" }; add-zsh-hook precmd __zy_osc7"
    } else if (shell.includes('fish')) {
      snippet =
        'function __zy_osc7 --on-event fish_prompt; printf \'\\033]7;file://%s%s\\a\' (hostname) (pwd); end'
    } else {
      snippet =
        'export PROMPT_COMMAND=\'printf "\\033]7;file://%s%s\\a" "$(hostname)" "$PWD"\''
    }
    this.clearEchoFilter()
    this.pendingEcho = snippet
    dbg(`inject snippet=${JSON.stringify(snippet)}`)
    this.write(snippet + '\n')
  }

  /** 回显过滤结束（匹配完成或兜底放弃） */
  private clearEchoFilter(): void {
    this.pendingEcho = ''
    this.echoHold = 0
    this.echoStripped = 0
    this.echoSeen = 0
  }

  /** 从输出缓冲中剥离注入命令的终端回显（字节级精确匹配） */
  private stripPendingEcho(): void {
    if (!this.pendingEcho) return
    // 回显最多两处：PTY 行缓冲的就地回显 + readline 接管输入后的重绘
    for (;;) {
      const idx = this.outBuf.indexOf(this.pendingEcho)
      if (idx < 0) break
      this.outBuf =
        this.outBuf.slice(0, idx) +
        this.outBuf.slice(idx + this.pendingEcho.length)
      this.echoStripped++
    }
    if (this.echoStripped >= 2) {
      this.clearEchoFilter()
      return
    }
    // 兜底：自注入起已流出大量数据仍未凑齐回显，放弃过滤避免长期扣住尾部字节
    if (this.echoSeen > 16384) {
      this.clearEchoFilter()
      return
    }
    // 尾部若是回显被 TCP 分片截断的前缀，保留待下一片拼齐
    this.echoHold = 0
    for (let len = Math.min(this.pendingEcho.length, this.outBuf.length); len > 0; len--) {
      if (this.outBuf.endsWith(this.pendingEcho.slice(0, len))) {
        this.echoHold = len
        break
      }
    }
  }

  /** 解析 OSC 7 的 file://host/path 并更新 cwd */
  private onOsc7(uri: string): void {
    try {
      const path = decodeURIComponent(uri.slice(uri.indexOf('/')))
      if (!path.startsWith('/')) return
      this.cwd = path
      const waiters = this.cwdWaiters
      this.cwdWaiters = []
      waiters.forEach((r) => r(path))
      this.send('ssh:cwd-changed', this.sessionId, path)
    } catch {
      /* 非法 URI，忽略 */
    }
  }

  /** shell 输出处理：剥离注入命令回显与 OSC 7 序列，其余转发给终端 */
  private onData(data: Buffer): void {
    this.outBuf += data.toString('utf8')
    dbg(`onData len=${data.length} raw=${JSON.stringify(data.toString('utf8').slice(0, 160))}`)
    if (this.pendingEcho) {
      this.echoSeen += data.length
      this.stripPendingEcho()
    }
    let out = ''
    for (;;) {
      const m = this.outBuf.match(OSC7_RE)
      if (!m || m.index === undefined) break
      out += this.outBuf.slice(0, m.index)
      this.onOsc7(m[1])
      this.outBuf = this.outBuf.slice(m.index + m[0].length)
    }
    // 保留可能被 TCP 分片截断的 OSC 7 尾部（开头序列的前缀、或未收到结束符的序列），
    // 其余立即转发；残留过长则视为普通输出直接放行，避免吞输出卡住终端
    let hold = this.echoHold
    const START = '\x1b]7;'
    for (let len = Math.min(START.length, this.outBuf.length); len > 0; len--) {
      if (this.outBuf.endsWith(START.slice(0, len))) {
        hold = Math.max(hold, len)
        break
      }
    }
    const open = this.outBuf.lastIndexOf(START)
    if (open >= 0 && this.outBuf.length - open < 1024) {
      hold = Math.max(hold, this.outBuf.length - open)
    }
    out += this.outBuf.slice(0, this.outBuf.length - hold)
    this.outBuf = this.outBuf.slice(this.outBuf.length - hold)
    if (out) {
      dbg(`send len=${out.length} hold=${hold} out=${JSON.stringify(out.slice(0, 160))}`)
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

  /** SFTP realpath：交给服务器解析 `~`/相对路径/符号链接（受限时回退本地解析） */
  private async sftpRealpath(p: string): Promise<string> {
    try {
      const sftp = await this.ensureSftp()
      return await new Promise<string>((resolve, reject) => {
        sftp.realpath(p, (err, abs) => (err ? reject(err) : resolve(abs)))
      })
    } catch {
      return resolveCd(this.cwd ?? '/', p.replace(/^~(?=\/|$)/, this.home), this.home)
    }
  }

  /** 浏览指定目录（不改变主 shell 目录），默认当前目录 */
  async listDir(
    path?: string
  ): Promise<{ cwd: string; entries: SshDirEntry[]; error?: string }> {
    const target = path ?? this.cwd ?? '/'
    try {
      // 优先走 SFTP 协议（结构化数据，无 ls 文本解析歧义，受限 shell 也可用）
      const sftp = await this.ensureSftp()
      const list = await new Promise<
        Array<{ filename: string; attrs: Stats }>
      >((resolve, reject) => {
        sftp.readdir(target, (err, files) => (err ? reject(err) : resolve(files)))
      })
      const entries: SshDirEntry[] = list.map((e) => {
        const attrs = e.attrs
        const isDir = typeof attrs.isDirectory === 'function' && attrs.isDirectory()
        const isLink = typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()
        return {
          name: e.filename,
          type: isDir ? 'dir' : isLink ? 'link' : 'file',
          size: e.attrs.size,
          mtime: new Date(e.attrs.mtime * 1000).toLocaleString()
        }
      })
      return { cwd: target, entries }
    } catch {
      // 服务器禁用/限制了 SFTP 子系统时降级为 exec + ls
      try {
        const { stdout, stderr } = await this.exec(
          `cd ${shellQuote(target)} && ls -la 2>&1`
        )
        return { cwd: target, entries: parseLs(stdout || stderr) }
      } catch (e) {
        return { cwd: target, entries: [], error: (e as Error).message }
      }
    }
  }

  /** 手动切换目录：向主 shell 写入 cd 并更新 cwd */
  async cd(path: string): Promise<{ cwd: string; entries: SshDirEntry[] }> {
    let target: string
    if (path === '-') {
      target = this.oldPwd || this.cwd || this.home
    } else {
      target = path === '~' ? this.home : await this.sftpRealpath(path)
    }
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
