/**
 * XMODEM / XMODEM-1K 文件传输协议（发送方 + 接收方）
 *
 * 仅依赖双向字节流（串口 / TCP 网络串口均可承载）。
 * - 数据块：128 字节(SOH) 或 1024 字节(STX, XMODEM-1K)，每块必须发满整块，
 *   尾块不足时以 0x1A(Ctrl-Z, SUB) 填充（XMODEM 规范）
 * - 校验：CRC16 (XMODEM，多项式 0x1021，初值 0)，握手用 'C'
 * - 流程：
 *   发送方：等待对方握手('C'/NAK) → 逐块发送 → 收 ACK 后发下一块（NAK/超时重发
 *   当前未确认块）→ 全部发完发 EOT → 等 ACK
 *   接收方：持续发 'C' 请求 → 收块校验 → ACK/NAK → 收 EOT → ACK →
 *           剥离尾块 0x1A 填充
 */

export const XMODEM = {
  SOH: 0x01, // 128 字节块
  STX: 0x02, // 1024 字节块
  EOT: 0x04,
  ACK: 0x06,
  NAK: 0x15,
  CAN: 0x18,
  SUB: 0x1a, // 尾块填充符（Ctrl-Z）
  CRC_REQ: 0x43 // 'C'：请求 CRC
}

/** 单块最大重试次数 */
const MAX_RETRY = 10
/** 等待/握手整体超时（ms） */
const WAIT_TIMEOUT = 60000
/** 接收方等待首块时，重新发送 'C' 请求的间隔（ms） */
const REQ_INTERVAL = 3000

/** CRC16-XMODEM（0x1021，初值 0） */
export function crc16(data: Buffer | number[]): number {
  let crc = 0
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

export interface XmodemCallbacks {
  write: (b: Buffer) => void
  onProgress?: (sent: number, total: number) => void
  onDone?: (error?: string) => void
}

/**
 * 发送方：把文件数据以 XMODEM-1K 帧发给对端（对端需先进入接收，如设备端 rz/rx）
 *
 * 大文件（>=1024 字节）全程用 1024 字节(STX) 块，小文件用 128 字节(SOH) 块；
 * 尾块不足整块时填充 0x1A。NAK/超时仅重发当前未确认块，不影响已确认进度。
 */
export class XmodemSender {
  private data: Buffer
  /** 下一新块的起始偏移 */
  private pos = 0
  /** 下一新块序号 */
  private blk = 1
  private phase: 'await' | 'send' | 'eot' | 'done' = 'await'
  private retry = 0
  /** 当前未确认块（重发同一块用） */
  private inFlight: { payload: Buffer; sent: number } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private cb: XmodemCallbacks
  private errored = false

  constructor(data: Buffer, cb: XmodemCallbacks) {
    this.data = data
    this.cb = cb
  }

  /** 开始发送：等待对端握手信号（'C' 或 NAK）；超时无握手则报错 */
  start(): void {
    this.timer = setTimeout(() => this.fail('等待对方握手超时'), WAIT_TIMEOUT)
  }

  /** 主动取消传输（发 CAN 通知对端中断） */
  abort(): void {
    if (this.errored || this.phase === 'done') return
    this.fail('已取消')
  }

  /** 喂入对端返回的字节（握手 / ACK / NAK / CAN） */
  feed(b: number): void {
    if (this.errored || this.phase === 'done') return
    this.clearTimer()
    if (this.phase === 'await') {
      if (b === XMODEM.CRC_REQ || b === XMODEM.NAK) {
        this.phase = 'send'
        this.retry = 0
        this.sendBlock()
      } else if (b === XMODEM.CAN) {
        this.fail('对端取消传输')
      } else {
        this.armWait(WAIT_TIMEOUT)
      }
    } else if (this.phase === 'send') {
      if (b === XMODEM.ACK) {
        this.retry = 0
        this.inFlight = null
        this.sendBlock()
      } else if (b === XMODEM.NAK) {
        this.retry++
        if (this.retry > MAX_RETRY) this.fail('重试次数过多')
        else this.sendBlock()
      } else if (b === XMODEM.CAN) {
        this.fail('对端取消传输')
      } else {
        this.armWait(2000)
      }
    } else if (this.phase === 'eot') {
      if (b === XMODEM.ACK) {
        this.done()
      } else if (b === XMODEM.NAK || b === XMODEM.CRC_REQ) {
        this.retry++
        if (this.retry > MAX_RETRY) this.fail('EOT 未确认')
        else this.sendEot()
      } else if (b === XMODEM.CAN) {
        this.fail('对端取消传输')
      } else {
        this.armWait(2000)
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private armWait(ms: number): void {
    this.timer = setTimeout(() => {
      this.retry++
      if (this.phase === 'send' && this.retry <= MAX_RETRY) this.sendBlock()
      else if (this.phase === 'eot' && this.retry <= MAX_RETRY) this.sendEot()
      else this.fail('对端无响应（超时）')
    }, ms)
  }

  /** 发送一个块：有未确认块则重发它，否则发送新块（或全部发完转 EOT） */
  private sendBlock(): void {
    this.clearTimer()
    if (this.inFlight) {
      this.cb.write(this.inFlight.payload)
      this.cb.onProgress?.(this.inFlight.sent, this.data.length)
      this.armWait(3000)
      return
    }
    this.beginNextBlock()
  }

  private beginNextBlock(): void {
    if (this.pos >= this.data.length) {
      // 全部块已确认，发送 EOT
      this.phase = 'eot'
      this.retry = 0
      this.sendEot()
      return
    }
    // 大文件全程 1024(STX, XMODEM-1K)；小文件 128(SOH)。避免中途换块长
    const use1k = this.data.length >= 1024
    const size = use1k ? 1024 : 128
    const remaining = this.data.length - this.pos
    const n = Math.min(size, remaining)
    const chunk = Buffer.alloc(size)
    this.data.copy(chunk, 0, this.pos, this.pos + n)
    // 尾块不足整块：以 0x1A 填充到完整块
    if (n < size) chunk.fill(XMODEM.SUB, n)
    const header = use1k ? XMODEM.STX : XMODEM.SOH
    const blk = this.blk & 0xff
    const payload = Buffer.alloc(3 + size + 2)
    payload[0] = header
    payload[1] = blk
    payload[2] = (255 - blk) & 0xff
    chunk.copy(payload, 3)
    const crc = crc16(chunk)
    payload[3 + size] = (crc >> 8) & 0xff
    payload[3 + size + 1] = crc & 0xff
    this.blk++
    this.pos += size
    this.inFlight = { payload, sent: Math.min(this.pos, this.data.length) }
    this.cb.write(payload)
    this.cb.onProgress?.(this.inFlight.sent, this.data.length)
    this.armWait(3000) // 等 ACK/NAK
  }

  private sendEot(): void {
    this.clearTimer()
    this.cb.write(Buffer.from([XMODEM.EOT]))
    this.armWait(3000)
  }

  private fail(msg: string): void {
    if (this.errored) return
    this.errored = true
    this.clearTimer()
    try {
      this.cb.write(Buffer.from([XMODEM.CAN, XMODEM.CAN]))
    } catch {
      /* ignore */
    }
    this.cb.onDone?.(msg)
  }

  private done(): void {
    if (this.errored) return
    this.clearTimer()
    this.phase = 'done'
    this.cb.onDone?.()
  }
}

/** 接收方：接收对端（如设备端 sz/sx）传来的文件 */
export class XmodemReceiver {
  private chunks: Buffer[] = []
  private expectedBlk = 1
  private started = false
  private errored = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private resendTimer: ReturnType<typeof setInterval> | null = null
  private buf: number[] = []
  private cb: XmodemCallbacks & { onChunk?: (full: Buffer) => void }

  constructor(cb: XmodemCallbacks & { onChunk?: (full: Buffer) => void }) {
    this.cb = cb
  }

  /** 开始接收：发 'C'（请求 CRC 握手）并启动整体超时；未收到首块前持续重发 'C' */
  start(): void {
    if (this.errored || this.started) return
    this.started = true
    this.cb.write(Buffer.from([XMODEM.CRC_REQ]))
    this.resendTimer = setInterval(() => {
      if (!this.errored) this.cb.write(Buffer.from([XMODEM.CRC_REQ]))
    }, REQ_INTERVAL)
    this.timer = setTimeout(() => this.fail('等待对方发送超时'), WAIT_TIMEOUT)
  }

  /** 喂入对端字节流 */
  feed(data: Buffer): void {
    if (this.errored) return
    for (let i = 0; i < data.length; i++) {
      this.buf.push(data[i])
    }
    this.parse()
  }

  private parse(): void {
    while (!this.errored && this.buf.length > 0) {
      const b = this.buf[0]
      if (b === XMODEM.SOH || b === XMODEM.STX) {
        const len = b === XMODEM.STX ? 1024 : 128
        // 需要 blk + ~blk + len + crc(2)
        if (this.buf.length < 1 + 2 + len + 2) break
        const blk = this.buf[1]
        const notblk = this.buf[2]
        const data = Buffer.from(this.buf.slice(3, 3 + len))
        const crcHi = this.buf[3 + len]
        const crcLo = this.buf[3 + len + 1]
        this.buf.splice(0, 1 + 2 + len + 2)
        if ((blk ^ notblk) !== 0xff) {
          this.cb.write(Buffer.from([XMODEM.NAK]))
          continue
        }
        if (blk === (this.expectedBlk & 0xff)) {
          if (crc16(data) !== ((crcHi << 8) | crcLo)) {
            this.cb.write(Buffer.from([XMODEM.NAK]))
            continue
          }
          this.chunks.push(data)
          this.expectedBlk++
          this.cb.write(Buffer.from([XMODEM.ACK]))
          // 已进入传输，无需继续请求握手
          this.stopResend()
        } else if (blk === ((this.expectedBlk - 1) & 0xff)) {
          // 重复块：重发 ACK
          this.cb.write(Buffer.from([XMODEM.ACK]))
        } else {
          this.cb.write(Buffer.from([XMODEM.NAK]))
        }
      } else if (b === XMODEM.EOT) {
        this.buf.shift()
        this.cb.write(Buffer.from([XMODEM.ACK]))
        this.finish()
        return
      } else if (b === XMODEM.CAN) {
        this.buf.shift()
        this.fail('发送方取消')
        return
      } else {
        // 非协议字节（传输前残留文本等）：丢弃
        this.buf.shift()
      }
    }
  }

  private finish(): void {
    if (this.errored) return
    this.clearTimer()
    this.stopResend()
    let full = Buffer.concat(this.chunks)
    // XMODEM 尾块用 0x1A 填充：收端剥掉结尾的填充符
    let end = full.length
    while (end > 0 && full[end - 1] === XMODEM.SUB) end--
    if (end < full.length) full = full.subarray(0, end)
    this.errored = true
    this.cb.onChunk?.(full)
    this.cb.onDone?.()
  }

  private fail(msg: string): void {
    if (this.errored) return
    this.errored = true
    this.clearTimer()
    this.stopResend()
    try {
      this.cb.write(Buffer.from([XMODEM.CAN, XMODEM.CAN]))
    } catch {
      /* ignore */
    }
    this.cb.onDone?.(msg)
  }

  /** 主动取消接收 */
  abort(): void {
    if (this.errored) return
    this.fail('已取消')
  }

  private stopResend(): void {
    if (this.resendTimer) {
      clearInterval(this.resendTimer)
      this.resendTimer = null
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
