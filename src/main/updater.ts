import { app, BrowserWindow } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { UpdaterState } from '@shared/types'

/**
 * 自动更新（electron-updater + GitHub Releases）
 *
 * - 仅打包版（app.isPackaged）启用；开发模式跳过
 * - 发布源由 electron-builder 打包时生成的 app-update.yml 决定（package.json 的
 *   build.publish → GitHub Releases，含 latest.yml + 安装包）
 * - 流程：启动后自动检查 → 渲染端提示"发现新版本" → 用户确认后下载 →
 *   下载完成 → 用户点击重启安装
 * - 所有状态通过 IPC 广播到渲染进程（channel: updater:status）
 */

let initialized = false
/** 当前更新状态：用于避免"已下载/下载中"时重复检查 */
let currentState: UpdaterState = { state: 'idle' }

function broadcast(payload: UpdaterState): void {
  currentState = payload
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', payload)
  }
}

/** 安全检查更新：已下载/下载中不重复检查 */
function safeCheck(): void {
  if (currentState.state === 'downloaded' || currentState.state === 'downloading') return
  void autoUpdater.checkForUpdates().catch(() => {
    /* 失败由 error 事件上报 */
  })
}

function releaseNotesText(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n')
  }
  return undefined
}

/** 初始化自动更新（主进程启动时调用一次） */
export function initUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  // 先提示再下载，避免自动下载大安装包
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ state: 'available', version: info.version, notes: releaseNotesText(info) })
  )
  autoUpdater.on('update-not-available', () =>
    broadcast({ state: 'not-available', version: app.getVersion() })
  )
  autoUpdater.on('download-progress', (p) =>
    broadcast({
      state: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ state: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) =>
    broadcast({ state: 'error', message: err?.message ?? String(err) })
  )

  // 启动后延迟自动检查（避免干扰首屏），之后每小时自动检查一次
  setTimeout(() => safeCheck(), 5000)
  setInterval(() => safeCheck(), 60 * 60 * 1000)
}

/** 手动检查更新 */
export function checkForUpdates(): void {
  if (!app.isPackaged) return
  safeCheck()
}

/** 下载更新 */
export function downloadUpdate(): void {
  if (!app.isPackaged) return
  void autoUpdater.downloadUpdate().catch(() => {})
}

/** 退出并安装（用户确认后） */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall()
}
