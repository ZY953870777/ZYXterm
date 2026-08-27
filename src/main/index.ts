import { app } from 'electron'
import { ConnectionManager } from './connections/manager'
import { ProfileStore } from './store'
import { registerIpc } from './ipc'
import { initUpdater } from './updater'
import { WindowManager, allWindowsClosed } from './window-manager'

const manager = new ConnectionManager()
const store = new ProfileStore()
const windows = new WindowManager(manager)

app.whenReady().then(() => {
  registerIpc(manager, store, windows)
  windows.createWindow({ isMain: true })
  // 自动更新（仅打包版启用；启动 5 秒后自动检查 GitHub Releases）
  initUpdater()

  app.on('activate', () => {
    // macOS 点击 Dock 时若无窗口则重建主窗口
    if (windows.windowCount() === 0) windows.createWindow({ isMain: true })
  })
})

app.on('window-all-closed', () => allWindowsClosed())

// 退出前清理所有会话
app.on('before-quit', () => {
  manager.disposeAll()
})
