import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type {
  ConnectionProfile,
  NewProfileInput,
  SessionInfo,
  SerialPortInfo,
  SshDirEntry,
  UpdaterState
} from '@shared/types'

export interface DropResult {
  action: 'attach' | 'detach' | 'none'
  targetWindowId?: number
}

/** 暴露给渲染进程的安全 API */
const api = {
  platform: process.platform,

  // ---------- 通用 ----------
  selectFile: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectFile'),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:write', text),

  // ---------- 连接配置 ----------
  listProfiles: (): Promise<ConnectionProfile[]> => ipcRenderer.invoke('profiles:list'),
  saveProfile: (input: NewProfileInput): Promise<ConnectionProfile> =>
    ipcRenderer.invoke('profiles:save', input),
  updateProfile: (profile: ConnectionProfile): Promise<ConnectionProfile> =>
    ipcRenderer.invoke('profiles:update', profile),
  deleteProfile: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('profiles:delete', id),
  // 首页列表排序：同协议类别内把 fromId 移到 toId 位置
  reorderProfiles: (
    protocol: string,
    fromId: string,
    toId: string
  ): Promise<ConnectionProfile[]> =>
    ipcRenderer.invoke('profiles:reorder', protocol, fromId, toId),

  // ---------- 会话 ----------
  createSession: (profile: ConnectionProfile): Promise<SessionInfo> =>
    ipcRenderer.invoke('session:create', profile),
  closeSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('session:close', id),
  listSessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke('session:list'),

  // ---------- 终端 ----------
  terminalWrite: (id: string, data: string): void =>
    ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  onTerminalData: (cb: (id: string, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, data: string): void =>
      cb(id, data)
    ipcRenderer.on('terminal:data', listener)
    return () => {
      ipcRenderer.removeListener('terminal:data', listener)
    }
  },
  onConnectionStatus: (cb: (info: SessionInfo) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: SessionInfo): void => cb(info)
    ipcRenderer.on('connection:status', listener)
    return () => {
      ipcRenderer.removeListener('connection:status', listener)
    }
  },

  // ---------- 串口 ----------
  listSerialPorts: (): Promise<SerialPortInfo[]> =>
    ipcRenderer.invoke('serial:list'),

  // ---------- VNC / RDP WebSocket 端点 ----------
  getWsEndpoint: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('vnc:endpoint', id),

  // ---------- RDP（FreeRDP 嵌入式：帧 + 输入） ----------
  rdpInput: (id: string, input: unknown): void =>
    ipcRenderer.send('rdp:input', id, input),
  // 跟随容器尺寸动态调整远程分辨率
  rdpSetSize: (id: string, width: number, height: number): void =>
    ipcRenderer.send('rdp:setSize', id, width, height),
  onRdpFrame: (
    cb: (id: string, frame: { x: number; y: number; width: number; height: number; data: Uint8Array }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, frame: unknown): void =>
      cb(id, frame as never)
    ipcRenderer.on('rdp:frame', listener)
    return () => {
      ipcRenderer.removeListener('rdp:frame', listener)
    }
  },
  onRdpResize: (cb: (id: string, size: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, size: string): void =>
      cb(id, size)
    ipcRenderer.on('rdp:resize', listener)
    return () => {
      ipcRenderer.removeListener('rdp:resize', listener)
    }
  },
  onRdpPointer: (
    cb: (id: string, ptr: { x: number; y: number; width: number; height: number; data: Uint8Array }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, ptr: unknown): void =>
      cb(id, ptr as never)
    ipcRenderer.on('rdp:pointer', listener)
    return () => {
      ipcRenderer.removeListener('rdp:pointer', listener)
    }
  },

  // ---------- RDP ----------
  detectRdp: (): Promise<{ available: boolean }> =>
    ipcRenderer.invoke('rdp:detect'),

  // ---------- SSH 增强（文件树 / 目录同步） ----------
  sshGetCwd: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('ssh:getCwd', id),
  sshListDir: (
    id: string,
    path?: string
  ): Promise<{ cwd: string; entries: SshDirEntry[] }> =>
    ipcRenderer.invoke('ssh:listDir', id, path),
  sshCd: (id: string, path: string): Promise<{ cwd: string; entries: SshDirEntry[] }> =>
    ipcRenderer.invoke('ssh:cd', id, path),
  sshCommand: (id: string, cmd: string): void => ipcRenderer.send('ssh:command', id, cmd),
  onSshCwdChanged: (cb: (id: string, cwd: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, id: string, cwd: string): void => cb(id, cwd)
    ipcRenderer.on('ssh:cwd-changed', listener)
    return () => {
      ipcRenderer.removeListener('ssh:cwd-changed', listener)
    }
  },
  sshDownload: (
    id: string,
    remotePath: string
  ): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('ssh:download', id, remotePath),
  sshUpload: (
    id: string,
    remotePath: string,
    localPath: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ssh:upload', id, remotePath, localPath),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ---------- 窗口控制（自定义标题栏） ----------
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: (): void => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: (): void => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => {
      ipcRenderer.removeListener('window:maximized', listener)
    }
  },
  // 全屏（会话页面全屏：BrowserWindow 真全屏）
  setFullScreen: (fullscreen: boolean): void =>
    ipcRenderer.send('window:set-fullscreen', fullscreen),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
  onFullScreen: (cb: (fullscreen: boolean) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, fullscreen: boolean): void => cb(fullscreen)
    ipcRenderer.on('window:fullscreen', listener)
    return () => {
      ipcRenderer.removeListener('window:fullscreen', listener)
    }
  },

  // ---------- 多窗口：tab 分离 / 合并 ----------
  registerWindow: (): void => ipcRenderer.send('window:register'),
  notifyTabsChanged: (tabs: string[]): void => ipcRenderer.send('tabs:changed', tabs),
  dropTab: (): Promise<DropResult> => ipcRenderer.invoke('tab:drop'),
  attachTab: (
    profile: ConnectionProfile,
    sessionId: string,
    targetWindowId: number
  ): Promise<void> => ipcRenderer.invoke('tab:attach', { profile, sessionId, targetWindowId }),
  detachTab: (profile: ConnectionProfile, sessionId: string): Promise<void> =>
    ipcRenderer.invoke('tab:detach', { profile, sessionId }),
  onAttachTab: (cb: (profile: ConnectionProfile, sessionId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, profile: ConnectionProfile, sessionId: string): void =>
      cb(profile, sessionId)
    ipcRenderer.on('window:attach-tab', listener)
    return () => {
      ipcRenderer.removeListener('window:attach-tab', listener)
    }
  },
  onInitProfile: (cb: (profile: ConnectionProfile, sessionId: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, profile: ConnectionProfile, sessionId: string): void =>
      cb(profile, sessionId)
    ipcRenderer.on('window:init-profile', listener)
    return () => {
      ipcRenderer.removeListener('window:init-profile', listener)
    }
  },

  // ---------- 自动更新 ----------
  checkForUpdates: (): void => ipcRenderer.send('updater:check'),
  downloadUpdate: (): void => ipcRenderer.send('updater:download'),
  installUpdate: (): void => ipcRenderer.send('updater:install'),
  onUpdaterStatus: (cb: (s: UpdaterState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, s: UpdaterState): void => cb(s)
    ipcRenderer.on('updater:status', listener)
    return () => {
      ipcRenderer.removeListener('updater:status', listener)
    }
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
