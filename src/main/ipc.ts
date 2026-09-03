import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { appendFileSync, promises as fsp } from 'fs'
import { ConnectionManager } from './connections/manager'
import { SerialSession } from './connections/serial'
import { SSHSession } from './connections/ssh'
import { RDPSession2, isAddonAvailable } from './connections/rdp2'
import { getSerialPortModule } from './serialport-loader'
import { ProfileStore } from './store'
import { checkForUpdates, downloadUpdate, quitAndInstall } from './updater'
import { WindowManager } from './window-manager'
import {
  ConnectionProfile,
  GlobalMacroStep,
  NewProfileInput,
  ProtocolType,
  SerialMacroStep,
  SerialPortInfo
} from '@shared/types'

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

  // 临时调试：渲染层日志写入 userData/debug.log（排查弹窗滚动/焦点等 UI 问题）
  ipcMain.on('debug:log', (_e, msg: string) => {
    try {
      appendFileSync(
        app.getPath('userData') + '/debug.log',
        new Date().toISOString() + ' ' + String(msg) + '\n'
      )
    } catch {
      /* ignore */
    }
  })

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

  // 首页列表排序：同协议类别内将 fromId 移动到 toId 位置（落在目标项之前），
  // 持久化到配置文件并返回新的 profiles 数组。
  ipcMain.handle(
    'profiles:reorder',
    (_e, protocol: ProtocolType, fromId: string, toId: string) => {
      const profiles = store.load()
      const idxs = profiles
        .map((p, i) => (p.protocol === protocol ? i : -1))
        .filter((i) => i >= 0)
      const items = idxs.map((i) => profiles[i])
      const fi = items.findIndex((p) => p.id === fromId)
      if (fi < 0) return profiles
      const insertAt = items.findIndex((p) => p.id === toId)
      if (insertAt < 0 || insertAt === fi) return profiles
      const next = items.filter((p) => p.id !== fromId)
      // fromId 原在 toId 之后时，toId 在新数组中的位置不变；之前时需按移除后索引插入
      next.splice(insertAt, 0, items[fi])
      for (let k = 0; k < idxs.length; k++) profiles[idxs[k]] = next[k]
      store.save(profiles)
      return profiles
    }
  )

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
      const listFn = mod.list
      if (typeof listFn !== 'function') return []
      const ports = (await listFn()) as Array<{
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

  // ---------- 串口 XMODEM 文件传输 ----------
  const serialSession = (id: string): SerialSession | null => {
    const s = manager.get(id)
    return s && s.profile.protocol === 'serial' ? (s as SerialSession) : null
  }
  // 发送：选本地文件后经 XMODEM 发给设备（对端需先执行 rx/sb -k 接收）。
  // defaultPath 为上次选中的路径（对话框默认定位到该目录/文件）
  ipcMain.handle('serial:xmodem-send', async (_e, id: string, defaultPath?: string) => {
    const s = serialSession(id)
    if (!s) return { ok: false, error: '会话不可用' }
    if (s.status !== 'connected') return { ok: false, error: '串口未连接' }
    const res = await dialog.showOpenDialog({
      title: '选择要发送的文件（XMODEM）',
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : undefined,
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: '已取消' }
    const file = res.filePaths[0]
    const r = s.xmodemSend(file)
    return r.ok ? { ok: true, path: file } : r
  })
  // 接收：选保存路径后进入 XMODEM 接收（对端需先执行 sz -k 文件名发送）。
  // defaultPath 为上次保存路径（默认填入）
  ipcMain.handle('serial:xmodem-receive', async (_e, id: string, defaultPath?: string) => {
    const s = serialSession(id)
    if (!s) return { ok: false, error: '会话不可用' }
    if (s.status !== 'connected') return { ok: false, error: '串口未连接' }
    const res = await dialog.showSaveDialog({
      title: '保存接收的文件（XMODEM）',
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : 'xmodem_received.bin'
    })
    if (res.canceled || !res.filePath) return { ok: false, error: '已取消' }
    const savePath = res.filePath
    const r = s.xmodemReceive(savePath)
    return r.ok ? { ok: true, path: savePath } : r
  })
  ipcMain.on('serial:xmodem-cancel', (_e, id: string) => {
    serialSession(id)?.cancelXmodem()
  })

  // ---------- 串口实时日志（用户自定义保存路径，实时追加） ----------
  // 开启：弹保存对话框（默认填入上次路径）→ 实时记录串口接收数据
  ipcMain.handle('serial:log-start', async (_e, id: string, defaultPath?: string) => {
    const s = serialSession(id)
    if (!s) return { ok: false, error: '会话不可用' }
    if (s.status !== 'connected') return { ok: false, error: '串口未连接' }
    if (s.logState().logging) return { ok: false, error: '日志已在记录中' }
    const res = await dialog.showSaveDialog({
      title: '保存串口实时日志（追加模式）',
      defaultPath: defaultPath && defaultPath.trim() ? defaultPath : 'serial.log'
    })
    if (res.canceled || !res.filePath) return { ok: false, error: '已取消' }
    const r = s.logStart(res.filePath)
    return r.ok ? { ok: true, path: res.filePath } : r
  })
  ipcMain.handle('serial:log-stop', (_e, id: string) => {
    serialSession(id)?.logStop()
    return { ok: true }
  })
  ipcMain.handle('serial:log-state', (_e, id: string) => {
    return serialSession(id)?.logState() ?? { logging: false }
  })

  // ---------- 串口自动化脚本（TX/RX/SLEEP） ----------
  ipcMain.handle(
    'serial:macro-start',
    (_e, id: string, run: { steps: SerialMacroStep[]; loop: number }) => {
      const s = serialSession(id)
      if (!s) return { ok: false, error: '会话不可用' }
      const steps = Array.isArray(run?.steps) ? run.steps : []
      return s.macroStart({ steps, loop: Number(run?.loop) || 1 })
    }
  )
  ipcMain.on('serial:macro-stop', (_e, id: string) => {
    serialSession(id)?.macroStop()
  })

  // ---------- 跨会话（多 SSH/串口）联动自动化 ----------
  ipcMain.handle('globalmacro:targets', () => manager.listAutomationTargets())
  ipcMain.handle(
    'globalmacro:start',
    (
      _e,
      run: { targets: string[]; steps: GlobalMacroStep[]; loop: number }
    ) => {
      const targets = Array.isArray(run?.targets) ? run.targets : []
      const steps = Array.isArray(run?.steps) ? run.steps : []
      return manager.runGlobalMacro({
        targets,
        steps,
        loop: Number(run?.loop) || 1
      })
    }
  )
  ipcMain.on('globalmacro:stop', () => manager.stopGlobalMacro())

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

  // ---------- 窗口控制（自定义标题栏：最小化/最大化/关闭） ----------
  const winFromEvent = (e: { sender: Electron.WebContents }): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)
  ipcMain.on('window:minimize', (e) => {
    winFromEvent(e)?.minimize()
  })
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = winFromEvent(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => {
    winFromEvent(e)?.close()
  })
  ipcMain.handle('window:is-maximized', (e) => {
    return winFromEvent(e)?.isMaximized() ?? false
  })

  // 全屏（会话页面全屏：BrowserWindow 真全屏，铺满整个显示器屏幕）
  ipcMain.on('window:set-fullscreen', (e, fullscreen: boolean) => {
    const win = winFromEvent(e)
    if (!win) return
    win.setFullScreen(!!fullscreen)
    // 乐观广播：不依赖 fullscreen 事件/isFullScreen()，确保渲染端状态即时准确，
    // 避免 isFullScreen() 残留误报导致标题栏被误隐藏
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen', !!fullscreen)
  })
  ipcMain.handle('window:is-fullscreen', (e) => {
    return winFromEvent(e)?.isFullScreen() ?? false
  })

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
