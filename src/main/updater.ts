import { app, BrowserWindow } from 'electron'
import type { UpdateInfo } from 'electron-updater'
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

/** Electron 主版本 */
const ELECTRON_MAJOR = Number(process.versions.electron?.split('.')[0] ?? 0)
/**
 * Electron 22（Windows Server 2012 R2 legacy 包）无法运行现代 Electron 43
 * 的安装包，因此老版本 Electron 完全禁用自动更新，避免升级后直接启动失败。
 */
const UPDATES_SUPPORTED = ELECTRON_MAJOR >= 28

/**
 * 懒加载 electron-updater：legacy（Electron 22）构建不加载该模块，
 * 避免其使用新版本 Electron 才有的 API 导致主进程启动异常。
 */
let updaterInstance: typeof import('electron-updater').autoUpdater | null = null
function getUpdater(): typeof import('electron-updater').autoUpdater {
  if (!updaterInstance) {
    updaterInstance = (
      require('electron-updater') as typeof import('electron-updater')
    ).autoUpdater
  }
  return updaterInstance
}

function broadcast(payload: UpdaterState): void {
  currentState = payload
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', payload)
  }
}

/** 安全检查更新：已下载/下载中不重复检查 */
function safeCheck(): void {
  if (!UPDATES_SUPPORTED) return
  if (currentState.state === 'downloaded' || currentState.state === 'downloading') return
  void getUpdater().checkForUpdates().catch(() => {
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
  if (initialized || !app.isPackaged || !UPDATES_SUPPORTED) return
  initialized = true

  const autoUpdater = getUpdater()
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
  if (!app.isPackaged || !UPDATES_SUPPORTED) return
  safeCheck()
}

/** 下载更新 */
export function downloadUpdate(): void {
  if (!app.isPackaged || !UPDATES_SUPPORTED) return
  void getUpdater().downloadUpdate().catch(() => {})
}

/** 退出并安装（用户确认后） */
export function quitAndInstall(): void {
  if (!app.isPackaged || !UPDATES_SUPPORTED) return
  getUpdater().quitAndInstall()
}
