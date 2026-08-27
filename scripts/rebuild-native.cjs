#!/usr/bin/env node
/**
 * 精确重建 Electron 原生模块（仅 @serialport/bindings-cpp）
 *
 * 背景：
 * - ssh2 的可选依赖 cpu-features（性能加速）在用较旧 GCC 的环境编译
 *   Electron 43 的 V8 头文件时会失败（Docker 打包镜像、老系统等）。
 * - cpu-features 非必需：ssh2 加载失败会自动回退纯 JS 实现。
 * - 因此这里只重建串口需要的 @serialport/bindings-cpp，
 *   不触碰 cpu-features，避免打包时因编译失败中断。
 */
const path = require('node:path')
const { rebuild } = require('@electron/rebuild')

async function main() {
  const electronPkg = require(path.join(process.cwd(), 'node_modules/electron/package.json'))
  const electronVersion = electronPkg.version
  const base = { buildPath: process.cwd(), electronVersion, force: true }

  // 1) serialport（必选）：重建为 Electron ABI
  console.log(`[rebuild-native] Electron ${electronVersion}，重建 @serialport/bindings-cpp ...`)
  await rebuild({ ...base, onlyModules: ['@serialport/bindings-cpp'] })
  console.log('[rebuild-native] ✅ @serialport/bindings-cpp 已重建为 Electron ABI')

  // 2) freerdp（可选）：需要系统 freerdp3-dev 头文件；缺失（如打包容器）时
  //    跳过并回退到预编译产物（resources/freerdp/build/Release/freerdp.node）
  console.log('[rebuild-native] 重建 freerdp addon ...')
  try {
    await rebuild({ ...base, modulePath: ['native/freerdp'], onlyModules: ['freerdp'] })
    console.log('[rebuild-native] ✅ freerdp addon 已重建为 Electron ABI')
  } catch (e) {
    console.warn(
      '[rebuild-native] ⚠ freerdp addon 重建失败（缺 freerdp3-dev 时正常）：' +
        (e && e.message ? e.message : e)
    )
    console.warn('[rebuild-native]   将使用预编译产物 resources/freerdp/build/Release/freerdp.node（若存在）')
  }
}

main().catch((err) => {
  console.error('[rebuild-native] ❌ 原生模块重建失败:', err && err.message ? err.message : err)
  process.exit(1)
})
