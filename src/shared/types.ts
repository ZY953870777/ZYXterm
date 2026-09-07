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
  /** 连接成功后自动执行的命令（可选；交互 shell 中回车执行） */
  startupCommand?: string
}

export interface SerialProfile {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 2
  parity: 'none' | 'even' | 'odd'
  flowControl: 'none' | 'hardware' | 'software'
  /** 连接模式：local=本机串口(serialport)；tcp=网络串口(net.Socket) */
  mode?: 'local' | 'tcp'
  /** tcp 模式：目标主机（设备端 ser2net/socat 所在） */
  host?: string
  /** tcp 模式：目标端口 */
  port?: number
  /** tcp 模式：启用 RFC2217（Telnet 串口参数协商，动态改波特率/流控）——预留 */
  rfc2217?: boolean
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
  /**
   * 防止远端锁定（屏幕常亮）：开启后空闲超过 2 分钟时自动向远端注入一次
   * 无害按键（左 Ctrl 按下+抬起），重置远端空闲计时器，避免息屏/锁屏。
   */
  keepAwake?: boolean
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

/** 配置导出/导入的明文结构（导出前内存中组装；写入文件前整体加密） */
export interface ConfigBackup {
  /** 固定为 'zyxterm'，导入时校验 */
  app: 'zyxterm'
  /** 备份格式版本（结构不兼容时递增） */
  format: 1
  exportedAt: string
  /** 连接配置（含顺序：数组顺序即首页同类内的排列顺序；密码为明文） */
  profiles: ConnectionProfile[]
  /** 渲染层持久化偏好（localStorage 键 → 解析后的值）：
   *  类别列顺序、串口/联动自动化脚本、快捷命令分组等 */
  preferences: Record<string, unknown>
}

/** 配置导出文件（磁盘上的结构）：整个备份用口令（scrypt 派生密钥）+
 *  AES-256-GCM 加密，口令不随文件保存，跨机器导入时凭口令解密。 */
export interface ConfigBackupFile {
  app: 'zyxterm'
  format: 2
  cipher: 'aes-256-gcm'
  kdf: 'scrypt'
  /** scrypt 盐（base64） */
  salt: string
  /** 初始化向量（base64） */
  iv: string
  /** 认证标签（base64）：口令错误时解密在此失败 */
  tag: string
  /** 密文（ConfigBackup 序列化后加密，base64） */
  data: string
  /** 明文元信息（导入前展示用，不含敏感内容） */
  meta: { exportedAt: string; profileCount: number }
}

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

// ================= 跨会话（多 SSH/串口）联动自动化 =================

/** 联动脚本（localStorage 持久化）。语法：TX<ID> / RX<ID> / sleep，ID 为选中会话次序 */
export interface GlobalMacroScript {
  id: string
  name: string
  text: string
  /** -1 无限；>=1 有限 */
  loop: number
}

/** 联动脚本步骤（渲染层解析后下发主进程） */
export interface GlobalMacroStep {
  op: 'tx' | 'rx' | 'sleep'
  /** 目标会话下标（0..n-1）；sleep 无目标 */
  target: number
  text?: string
  secs?: number
}

/** 参与联动的一个会话（渲染层按当前打开的 SSH/串口选择并排序） */
export interface GlobalMacroTarget {
  sessionId: string
  profileId: string
  name: string
  kind: 'ssh' | 'serial'
}

/** 联动运行状态广播（channel: globalmacro:status） */
export type GlobalMacroStatus = {
  running: boolean
  state: 'running' | 'done' | 'stopped' | 'error'
  idx: number
  total: number
  iter: number
  loop: number
  targetIndex?: number
  targetName?: string
  op?: 'tx' | 'rx' | 'sleep'
  message?: string
}

/** 串口自动化脚本步骤（由渲染层解析脚本文本后下发主进程执行） */
export interface SerialMacroStep {
  op: 'tx' | 'rx' | 'sleep'
  /** tx 发送内容 / rx 等待内容（转义已解析） */
  text?: string
  /** sleep 秒数（由 s/m/h 换算） */
  secs?: number
}

/** 串口自动化脚本（localStorage 持久化） */
export interface SerialMacroScript {
  id: string
  name: string
  /** 原始脚本文本（多行：tx/rx/sleep，行首 # 为注释） */
  text: string
  /** 循环次数；-1 = 无限，>=1 有限 */
  loop: number
}

/** 自动化运行状态广播（channel: serial:macro-status） */
export type SerialMacroStatus = {
  running: boolean
  state: 'running' | 'done' | 'stopped' | 'error'
  /** 当前步骤（0-based） */
  idx: number
  total: number
  /** 当前第几轮（1-based） */
  iter: number
  /** 总轮数；-1 表示无限 */
  loop: number
  op?: 'tx' | 'rx' | 'sleep'
  message?: string
}

/**
 * XMODEM 传输状态（主进程 → 渲染进程广播，channel: serial:xmodem-status）
 * state:
 * - started: 已进入传输模式（UI 显示进度条）
 * - progress: 进度更新（sent/total，单位为字节；接收方向 total 在完成前未知）
 * - done / error / cancel: 传输结束（恢复普通终端显示）
 */
export type XmodemStatus = {
  state: 'started' | 'progress' | 'done' | 'error' | 'cancel'
  mode?: 'send' | 'recv'
  /** 已发送/接收字节 */
  sent?: number
  /** 总字节（发送方向可知；接收方向完成后为收到的长度） */
  total?: number
  message?: string
  /** 接收完成后的保存路径 */
  savePath?: string
  /** 传输文件名 */
  name?: string
}

/** 预设常用波特率 */
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
