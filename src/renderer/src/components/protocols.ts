import { ProtocolType } from '@shared/types'

export interface ProtocolMeta {
  key: ProtocolType
  label: string
  desc: string
}

/** 协议展示元数据（用于首页类别网格、选择框等） */
export const PROTOCOLS: ProtocolMeta[] = [
  { key: 'ssh', label: 'SSH', desc: '安全外壳' },
  { key: 'serial', label: '串口', desc: '串行设备' },
  { key: 'vnc', label: 'VNC', desc: '远程桌面' },
  { key: 'rdp', label: 'RDP', desc: '远程桌面' }
]
