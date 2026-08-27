/**
 * 全局共享类型定义（主进程 / 渲染进程共用）
 */

export type ProtocolType = 'ssh' | 'serial' | 'vnc' | 'rdp'

export interface SSHProfile {
  host: string
  port: number
  username: string
  /** 认证方式 */
  authType: 'password' | 'privateKey'
  password: string
  /** password 是否已加密存储（由主进程 store 维护，渲染进程始终为明文） */
  passwordEnc?: boolean
  privateKeyPath: string
  passphrase: string
  /** passphrase 是否已加密存储 */
  passphraseEnc?: boolean
}

export interface SerialProfile {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd'
  flowControl: 'none' | 'hardware' | 'software'
}

/** VNC 画面缩放方式 */
export type VNCScaleMode = 'none' | 'fit' | 'fill'

export interface VNCProfile {
  host: string
  port: number
  password: string
  /** password 是否已加密存储 */
  passwordEnc?: boolean
  viewOnly: boolean
  /** 自动缩放画面到窗口（旧字段，兼容：true≈fit / false≈none） */
  scaleView: boolean
  /** 画质 0-9，9 最高 */
  quality: number
  /**
   * 缩放方式（新）：
   * - none: 不缩放（原始分辨率）
   * - fit:  等比缩放适配容器（完整显示，可能留边）
   * - fill: 拉伸铺满容器（可能变形）
   */
  scaleMode?: VNCScaleMode
}

export interface RDPProfile {
  host: string
  port: number
  username: string
  password: string
  /** password 是否已加密存储 */
  passwordEnc?: boolean
  domain: string
  /** 分辨率，如 1280x800 */
  resolution: string
}

/** 持久化的连接配置 */
export interface ConnectionProfile {
  id: string
  name: string
  protocol: ProtocolType
  ssh?: SSHProfile
  serial?: SerialProfile
  vnc?: VNCProfile
  rdp?: RDPProfile
  createdAt: number
}

/** 新建/编辑配置时的输入（id 与 createdAt 由主进程生成） */
export type NewProfileInput = Omit<ConnectionProfile, 'id' | 'createdAt'>

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** 运行中会话的信息（标签页） */
/** 自动更新状态（主进程 → 渲染进程广播，channel: updater:status） */
export type UpdaterState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number; transferred?: number; total?: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface SessionInfo {
  sessionId: string
  profileId: string
  name: string
  protocol: ProtocolType
  status: ConnectionStatus
  message?: string
  /** VNC / RDP 会话的 WebSocket 端点（连接成功后可用） */
  wsEndpoint?: string
}

/** SSH 目录项（文件树用） */
export interface SshDirEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size: number
  mtime: string
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
}

/** 预设常用波特率 */
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

export const RDP_RESOLUTIONS = [
  '1024x768',
  '1280x720',
  '1280x800',
  '1366x768',
  '1440x900',
  '1600x900',
  '1920x1080',
  '2560x1440'
]
