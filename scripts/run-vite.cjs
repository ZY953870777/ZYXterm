#!/usr/bin/env node
/**
 * electron-vite 启动包装器（跨平台）
 *
 * 某些环境（如部分 WSL2/CI）会设置 ELECTRON_RUN_AS_NODE=1，
 * 该变量会强制 Electron 以 Node 模式运行，导致主进程拿不到
 * `require('electron').app` 等 API（报 "Cannot read properties of
 * undefined (reading 'whenReady')"）。
 *
 * 本脚本在调用 electron-vite 之前移除该环境变量，
 * 确保 Electron 始终以桌面 GUI 模式启动。
 */
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const child = spawn(bin, ['electron-vite', ...args], {
  stdio: 'inherit',
  env,
  // Windows 下 .cmd 需经 shell 执行，否则 CreateProcess 直接 spawn .cmd 报 EINVAL
  shell: process.platform === 'win32'
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
