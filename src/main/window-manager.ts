import { existsSync } from 'fs'
import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { ConnectionProfile } from '@shared/types'
import { ConnectionManager } from './connections/manager'

export interface DropResult {
  action: 'attach' | 'detach' | 'none'
  targetWindowId?: number
}

interface WinRecord {
  win: BrowserWindow
  tabs: string[]
  isMain: boolean
  /** 是否曾承载过 tab（避免新窗口接管前因空 tabs 被误关闭） */
  hadTabs: boolean
}

/**
 * 多窗口管理：
 * - 窗口注册表（主窗口 + 可分离/合并的独立窗口）
 * - tab 分离（detach）：向下拖拽 → 新建窗口承载该会话
 * - tab 合并（attach）：向下拖拽到另一窗口 → 会话移交给目标窗口，源窗口空则关闭
 * - 会话对象（连接）由 ConnectionManager 全局持有，窗口间移动是「接管」而非重连
 */
export class WindowManager {
  private records = new Map<number, WinRecord>()
  private mainId: number | null = null
  private manager: ConnectionManager

  constructor(manager: ConnectionManager) {
    this.manager = manager
  }

  /** 创建窗口。isMain=true 表示主窗口；profile 非空表示承载被分离的会话 */
  createWindow(opts: { isMain?: boolean; profile?: ConnectionProfile; sessionId?: string } = {}): BrowserWindow {
    // 应用图标（开发/运行时窗口图标；打包后 exe 自带图标，build/icon.png 不存在时跳过）
    const iconPath = join(process.cwd(), 'build', 'icon.png')
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#1a1b26',
      title: 'ZYXterm',
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    const wcId = win.webContents.id

    // 渲染完成：若承载被分离的会话，通知 renderer 接管（不重新连接）。
    // 稍作延迟，确保 renderer 已挂载并注册 onInitProfile 监听
    win.webContents.on('did-finish-load', () => {
      if (opts.profile && opts.sessionId) {
        setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send('window:init-profile', opts.profile, opts.sessionId)
          }
        }, 300)
      }
    })

    win.on('closed', () => {
      const rec = this.records.get(wcId)
      if (rec) {
        // 关闭该窗口仍持有的会话
        for (const sid of rec.tabs) {
          void this.manager.close(sid)
        }
        this.records.delete(wcId)
      }
      if (this.mainId === wcId) this.mainId = null
    })

    win.on('ready-to-show', () => win.show())

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }
    return win
  }

  /** renderer 启动上报注册。首个注册窗口自动设为主窗口 */
  register(win: BrowserWindow): void {
    const wcId = win.webContents.id
    if (this.mainId === null) this.mainId = wcId
    this.records.set(wcId, {
      win,
      tabs: [],
      isMain: wcId === this.mainId,
      hadTabs: false
    })
  }

  updateTabs(wcId: number, tabs: string[]): void {
    const rec = this.records.get(wcId)
    if (rec) {
      rec.tabs = tabs
      if (tabs.length > 0) rec.hadTabs = true
    }
  }

  isMain(wcId: number): boolean {
    return wcId === this.mainId
  }

  mainWindowId(): number | null {
    return this.mainId
  }

  windowCount(): number {
    return this.records.size
  }

  /** 依据当前鼠标屏幕坐标解析拖拽落点 */
  resolveDrop(wcId: number): DropResult {
    const pt = screen.getCursorScreenPoint()
    // 1) 落在其他窗口内 → 合并
    for (const [id, rec] of this.records) {
      if (id === wcId) continue
      if (rec.win.isDestroyed() || !rec.win.isVisible()) continue
      const b = rec.win.getBounds()
      if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
        return { action: 'attach', targetWindowId: id }
      }
    }
    // 2) 仍在源窗口内 → 取消（不分离）
    const src = this.records.get(wcId)?.win
    if (src && !src.isDestroyed()) {
      const b = src.getBounds()
      if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
        return { action: 'none' }
      }
    }
    // 3) 落在空白区域 → 分离为独立窗口
    return { action: 'detach' }
  }

  /** 分离：新建独立窗口接管该会话 */
  detach(profile: ConnectionProfile, sessionId: string): void {
    this.createWindow({ profile, sessionId })
  }

  /** 合并：通知目标窗口接管该会话 */
  attach(targetWcId: number, profile: ConnectionProfile, sessionId: string): void {
    const rec = this.records.get(targetWcId)
    if (rec && !rec.win.isDestroyed()) {
      rec.win.webContents.send('window:attach-tab', profile, sessionId)
    }
  }

  /** tab 移出某窗口后上报：曾承载过 tab 的独立窗口若清空 → 关闭该窗口 */
  maybeCloseDetached(wcId: number): void {
    const rec = this.records.get(wcId)
    if (!rec || rec.isMain) return
    if (rec.hadTabs && rec.tabs.length === 0 && !rec.win.isDestroyed()) {
      rec.win.close()
    }
  }

  /** 应用退出清理 */
  disposeAll(): void {
    for (const rec of this.records.values()) {
      if (!rec.win.isDestroyed()) rec.win.close()
    }
    this.records.clear()
    this.mainId = null
  }
}

/** 兼容 app 生命周期辅助 */
export function allWindowsClosed(): void {
  if (process.platform !== 'darwin') app.quit()
}
