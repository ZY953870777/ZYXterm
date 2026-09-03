import { ConnectionProfile, ConnectionStatus } from '@shared/types'

/** 主进程向渲染进程发送事件的函数 */
export type SendFn = (channel: string, ...args: unknown[]) => void

/** 所有协议会话的通用接口 */
export interface BaseSession {
  readonly sessionId: string
  readonly profile: ConnectionProfile
  status: ConnectionStatus
  error?: string
  connect(): Promise<void>
  dispose(): Promise<void>
  /** 终端输入（SSH/串口） */
  write?(data: string): void
  /** 终端尺寸变化（SSH/串口） */
  resize?(cols: number, rows: number): void
  /** 订阅解码后的输出文本（联动自动化 RX 匹配用）；返回退订函数 */
  subscribeData?(cb: (text: string) => void): () => void
}
