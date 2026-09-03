/**
 * RFC2217（Telnet Com Port Control Option）客户端协议层
 *
 * 用于"网络串口（TCP）"连接 ser2net 的 telnet(rfc2217) 端口时：
 * - 连接建立后下发 SET-BAUD / SET-DATASIZE / SET-PARITY / SET-STOPSIZE /
 *   SET-FLOWCONTROL 等，让客户端远程动态配置设备端串口参数
 * - 数据经 Telnet IAC 转义（0xFF → 0xFF 0xFF），并从服务器数据中剥离协议字节
 *
 * 参考：RFC 2217 - Telnet Com Port Control Option
 */

// Telnet 常量
const IAC = 0xff // Interpret As Command
const WILL = 0xfb
const WONT = 0xfc
const DO = 0xfd
const DONT = 0xfe
const SB = 0xfa // Sub-negotiation Begin
const SE = 0xf0 // Sub-negotiation End
const COM_PORT_OPTION = 44 // 0x2c

// RFC2217 子命令
const SET_BAUD = 0x01
const SET_DATASIZE = 0x02
const SET_PARITY = 0x03
const SET_STOPSIZE = 0x04
const SET_FLOWCONTROL = 0x05

export interface Rfc2217Params {
  baudRate: number
  dataBits: number
  parity: 'none' | 'even' | 'odd'
  stopBits: number
  flowControl: 'none' | 'hardware' | 'software'
}

/** 构造一条 RFC2217 SET 子命令（IAC SB COM-PORT-OPTION <cmd> <args> IAC SE） */
function setCommand(cmd: number, args: number[]): Buffer {
  return Buffer.from([IAC, SB, COM_PORT_OPTION, cmd, ...args, IAC, SE])
}

/** 连接建立后发送的握手 + 参数命令 */
export function buildSetup(p: Rfc2217Params): Buffer {
  const parts: Buffer[] = []
  // 请求服务器启用 COM-PORT-OPTION（RFC2217）
  parts.push(Buffer.from([IAC, DO, COM_PORT_OPTION]))
  // 二进制传输模式（避免服务器把 0xFF 当命令处理）
  parts.push(Buffer.from([IAC, WILL, 0x00])) // TRANSMIT-BINARY = 0
  // 波特率（4 字节大端）
  const baud = p.baudRate || 115200
  parts.push(
    setCommand(SET_BAUD, [
      (baud >>> 24) & 0xff,
      (baud >> 16) & 0xff,
      (baud >> 8) & 0xff,
      baud & 0xff
    ])
  )
  // 数据位
  parts.push(setCommand(SET_DATASIZE, [p.dataBits || 8]))
  // 校验：0=none 1=odd 2=even
  const parity = p.parity === 'even' ? 2 : p.parity === 'odd' ? 1 : 0
  parts.push(setCommand(SET_PARITY, [parity]))
  // 停止位
  parts.push(setCommand(SET_STOPSIZE, [p.stopBits || 1]))
  // 流控：0=none 1=XON/XOFF 2=RTS/CTS 3=DTR/DSR
  const fc = p.flowControl === 'software' ? 1 : p.flowControl === 'hardware' ? 2 : 0
  parts.push(setCommand(SET_FLOWCONTROL, [fc]))
  return Buffer.concat(parts)
}

/** 发送方向：数据中的 0xFF 需转义为 0xFF 0xFF */
export function encodeData(data: Buffer | string): Buffer {
  const src = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const out: number[] = []
  for (const b of src) {
    if (b === IAC) out.push(IAC, IAC)
    else out.push(b)
  }
  return Buffer.from(out)
}

/**
 * 接收方向：从服务器字节流中剥离 Telnet/RFC2217 协议字节，
 * 返回其中的纯串口数据
 */
export class Rfc2217Decoder {
  private buffer = Buffer.alloc(0)
  private state: 'data' | 'iac' | 'cmd' | 'sb' | 'sbopt' | 'sbse' = 'data'
  private sbOpt = 0
  private sbBuf: number[] = []

  /** 喂入服务器数据，返回解码后的串口数据（不含协议字节） */
  decode(chunk: Buffer): Buffer {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: number[] = []
    let i = 0
    while (i < this.buffer.length) {
      const b = this.buffer[i]
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'
          else out.push(b)
          break
        case 'iac':
          if (b === IAC) {
            out.push(IAC) // 转义后的 0xFF 数据字节
            this.state = 'data'
          } else if (b === WILL || b === WONT || b === DO || b === DONT) {
            this.state = 'cmd'
          } else if (b === SB) {
            this.state = 'sb' // 下一个字节是 option
          } else {
            this.state = 'data' // NOP/SE 等
          }
          break
        case 'cmd':
          // 命令后的 option 字节，跳过
          this.state = 'data'
          break
        case 'sb':
          this.sbOpt = b
          this.sbBuf = []
          this.state = 'sbopt'
          break
        case 'sbopt':
          if (b === IAC) this.state = 'sbse'
          else this.sbBuf.push(b)
          break
        case 'sbse':
          if (b === SE) {
            this.onSubNegotiation()
            this.state = 'data'
          } else {
            // 意外：回退到 sbopt 继续收集（容错）
            this.sbBuf.push(IAC, b)
            this.state = 'sbopt'
          }
          break
      }
      i++
    }
    // 丢弃已消费的字节（保留未完成的半截 IAC/SB 序列）
    this.buffer = this.buffer.subarray(i)
    return Buffer.from(out)
  }

  /** 处理收到的 RFC2217 子命令（SET-LINESTATE/MODEMSTATE 等，暂不处理） */
  private onSubNegotiation(): void {
    // 服务器可能回 SET-LINESTATE/SET-MODEMSTATE 等状态，客户端可忽略
    void this.sbOpt
    void this.sbBuf
  }
}
