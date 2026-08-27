import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { ConnectionManager } from './connections/manager'
import { SSHSession } from './connections/ssh'
import { RDPSession2, isAddonAvailable } from './connections/rdp2'
import { getSerialPortModule } from './serialport-loader'
import { ProfileStore } from './store'
import { checkForUpdates, downloadUpdate, quitAndInstall } from './updater'
import { WindowManager } from './window-manager'
import { ConnectionProfile, NewProfileInput, SerialPortInfo } from '@shared/types'

/** 注册所有 IPC 处理器 */
export function registerIpc(
  manager: ConnectionManager,
  store: ProfileStore,
  windows: WindowManager
): void {
  // ---------- 自动更新 ----------
  ipcMain.on('updater:check', () => checkForUpdates())
  ipcMain.on('updater:download', () => downloadUpdate())
  ipcMain.on('updater:install', () => quitAndInstall())

  // ---------- 通用 ----------
  ipcMain.handle('dialog:selectFile', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择文件',
      properties: ['openFile']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  // ---------- 剪贴板（VNC 互通） ----------
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })

  // ---------- 连接配置持久化 ----------
  ipcMain.handle('profiles:list', () => store.load())

  ipcMain.handle('profiles:save', (_e, input: NewProfileInput) => {
    const profiles = store.load()
    const profile: ConnectionProfile = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now()
    }
    profiles.push(profile)
    store.save(profiles)
    return profile
  })

  ipcMain.handle('profiles:update', (_e, profile: ConnectionProfile) => {
    const profiles = store.load()
    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) profiles[idx] = profile
    else profiles.push(profile)
    store.save(profiles)
    return profile
  })

  ipcMain.handle('profiles:delete', (_e, id: string) => {
    store.save(store.load().filter((p) => p.id !== id))
    return true
  })

  // ---------- 会话管理 ----------
  ipcMain.handle('session:create', (_e, profile: ConnectionProfile) =>
    manager.create(profile)
  )
  ipcMain.handle('session:close', (_e, id: string) => manager.close(id))
  ipcMain.handle('session:list', () => manager.list())

  // ---------- 终端数据 ----------
  ipcMain.on('terminal:write', (_e, id: string, data: string) => {
    manager.write(id, data)
  })
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    manager.resize(id, cols, rows)
  })

  // ---------- 串口 ----------
  ipcMain.handle('serial:list', async (): Promise<SerialPortInfo[]> => {
    const { mod } = getSerialPortModule()
    if (!mod) return []
    try {
      const ports = (await mod.list()) as Array<{
        path: string
        manufacturer?: string
        serialNumber?: string
        vendorId?: string
        productId?: string
      }>
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId
      }))
    } catch (e) {
      console.error('枚举串口失败:', e)
      return []
    }
  })

  // ---------- VNC / RDP WebSocket 端点 ----------
  ipcMain.handle('vnc:endpoint', (_e, id: string) => {
    const s = manager.get(id) as { wsEndpoint?: string } | undefined
    return s?.wsEndpoint ?? null
  })

  // ---------- RDP（FreeRDP 嵌入式） ----------
  ipcMain.handle('rdp:detect', async () => {
    const available = isAddonAvailable()
    return {
      available,
      message: available ? '使用内置 FreeRDP' : 'FreeRDP 原生模块未就绪'
    }
  })
  ipcMain.on('rdp:input', (_e, id: string, input: unknown) => {
    const s = manager.get(id)
    if (s && s.profile.protocol === 'rdp' && s instanceof RDPSession2) {
      s.sendInput(input as Parameters<RDPSession2['sendInput']>[0])
    }
  })
  // 渲染进程容器尺寸变化 → 动态调整远程分辨率（跟随容器铺满）
  ipcMain.on('rdp:setSize', (_e, id: string, width: number, height: number) => {
    const s = manager.get(id)
    if (s && s.profile.protocol === 'rdp' && s instanceof RDPSession2) {
      void s.resize(Math.round(width), Math.round(height)).catch(() => {
        /* 状态已通过事件上报 */
      })
    }
  })

  // ---------- SSH 增强（文件树 / 目录同步） ----------
  const sshSession = (id: string): SSHSession | null => {
    const s = manager.get(id)
    return s && s.profile.protocol === 'ssh' ? (s as SSHSession) : null
  }
  ipcMain.handle('ssh:getCwd', (_e, id: string) => sshSession(id)?.getCwd() ?? null)
  ipcMain.handle('ssh:listDir', (_e, id: string, path?: string) => {
    const s = sshSession(id)
    if (!s) return { cwd: '', entries: [] }
    return s.listDir(path)
  })
  ipcMain.handle('ssh:cd', (_e, id: string, path: string) => {
    const s = sshSession(id)
    if (!s) return { cwd: '', entries: [] }
    return s.cd(path)
  })
  ipcMain.on('ssh:command', (_e, id: string, cmd: string) => {
    sshSession(id)?.handleCommand(cmd)
  })

  // 下载远端文件到本地（保存对话框）
  ipcMain.handle('ssh:download', async (_e, id: string, remotePath: string) => {
    const s = sshSession(id)
    if (!s) return { saved: false, error: '会话不可用' }
    try {
      const data = await s.downloadFile(remotePath)
      const name = remotePath.split('/').pop() || 'download'
      const res = await dialog.showSaveDialog({
        title: '保存到本地',
        defaultPath: name
      })
      if (res.canceled || !res.filePath) return { saved: false }
      await fsp.writeFile(res.filePath, data)
      return { saved: true, path: res.filePath }
    } catch (e) {
      return { saved: false, error: (e as Error).message }
    }
  })

  // 上传本地文件到远端路径
  ipcMain.handle(
    'ssh:upload',
    async (_e, id: string, remotePath: string, localPath: string) => {
      const s = sshSession(id)
      if (!s) return { ok: false, error: '会话不可用' }
      try {
        const data = await fsp.readFile(localPath)
        await s.uploadFile(remotePath, data)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  // ---------- 多窗口：tab 分离 / 合并 ----------
  // renderer 启动注册窗口（首个注册窗口为主窗口）
  ipcMain.on('window:register', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) windows.register(win)
  })

  // renderer 上报本窗口持有的 tab（sessionId 列表）；独立窗口若空则自动关闭
  ipcMain.on('tabs:changed', (e, tabs: string[]) => {
    const wcId = e.sender.id
    windows.updateTabs(wcId, tabs)
    windows.maybeCloseDetached(wcId)
  })

  // 拖拽落点判断：根据鼠标屏幕坐标返回 attach / detach / none
  ipcMain.handle('tab:drop', (e) => windows.resolveDrop(e.sender.id))

  // 合并到目标窗口（会话交给目标窗口接管）
  ipcMain.handle(
    'tab:attach',
    (
      _e,
      payload: { profile: ConnectionProfile; sessionId: string; targetWindowId: number }
    ) => {
      windows.attach(payload.targetWindowId, payload.profile, payload.sessionId)
    }
  )

  // 分离为独立窗口（会话交给新窗口接管）
  ipcMain.handle('tab:detach', (e, payload: { profile: ConnectionProfile; sessionId: string }) => {
    windows.detach(payload.profile, payload.sessionId)
  })
}
