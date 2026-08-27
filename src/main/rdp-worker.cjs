// FreeRDP RDP 会话 Worker（Electron utility process）
//
// 在独立进程中加载 freerdp.node 并建立 RDP 会话，通过 process.parentPort
// 与主进程通信。即使 addon / FreeRDP 在连接时崩溃（如 Windows 0xc0000005），
// 也只崩溃本 utility 进程，主进程与 UI 保持稳定。
//
// 消息协议（与主进程 RDPSession2 约定）：
//   主进程 → worker: { cmd: 'init', config } | { cmd: 'input', input }
//   worker → 主进程: { type, payload }
//     type: 'status' | 'error' | 'frame' | 'resize'
//     frame payload: { x, y, width, height, data(Buffer RGBA) }
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// 崩溃诊断日志：写入临时目录文件，崩溃后可供分析（无需重编 addon，仅需重新打包）
const LOG_PATH = path.join(os.tmpdir(), 'zyxterm-rdp-worker.log')
function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + msg + '\n')
  } catch {
    /* ignore */
  }
  try {
    console.error('[rdp-worker] ' + msg)
  } catch {
    /* ignore */
  }
}

function findAddon() {
  const res = process.resourcesPath
  const dev = path.join(process.cwd(), 'native', 'freerdp', 'build', 'Release', 'freerdp.node')
  // Linux 打包时 resources/freerdp/ 根目录可能误带 Windows PE 版 freerdp.node
  // （用户从 freerdp-win64 下载放入），加载会报 "invalid ELF header"。
  // 因此 Linux 优先选择 build/Release 的 ELF 版；Windows 优先根目录的 PE 版。
  const cands =
    process.platform === 'linux'
      ? [
          path.join(res, 'freerdp', 'build', 'Release', 'freerdp.node'),
          dev
        ]
      : [
          path.join(res, 'freerdp', 'freerdp.node'),
          path.join(res, 'freerdp', 'build', 'Release', 'freerdp.node'),
          dev
        ]
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

// Windows 下把 resources/freerdp 根目录的 DLL 复制到 addon 同目录，保证可加载
function ensureDlls(addonPath) {
  if (process.platform !== 'win32') return
  try {
    const dir = path.dirname(addonPath)
    const resDir = path.join(process.resourcesPath, 'freerdp')
    if (!fs.existsSync(resDir)) return
    if (fs.realpathSync(resDir) === fs.realpathSync(dir)) return
    for (const f of fs.readdirSync(resDir)) {
      if (f.toLowerCase().endsWith('.dll')) {
        const src = path.join(resDir, f)
        const dst = path.join(dir, f)
        if (!fs.existsSync(dst)) {
          try {
            fs.copyFileSync(src, dst)
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function send(type, payload) {
  try {
    process.parentPort.postMessage({ type, payload })
  } catch {
    /* ignore */
  }
}

let session = null

// 打码敏感字段后再记日志，避免密码泄露到 rdp-worker.log
function sanitizeConfig(config) {
  const c = Object.assign({}, config)
  if ('password' in c) c.password = c.password ? '***' : ''
  return c
}

function start(config) {
  log('start config=' + JSON.stringify(sanitizeConfig(config)))
  log('addonPath=' + (findAddon() || 'null'))
  const addonPath = findAddon()
  if (!addonPath) {
    send('error', 'FreeRDP 原生模块未找到（resources/freerdp/ 下无 freerdp.node）')
    return
  }
  ensureDlls(addonPath)
  log('dll ensured')
  // OpenSSL 3 LEGACY provider（md4/rc4）用于 NTLM 认证与 RDP licensing：
  // 仅设 OPENSSL_MODULES 不够，还需 OPENSSL_CONF 显式启用 default + legacy，
  // 否则 Windows 上 "LEGACY provider failed to load" → licensing RC4 失败 → ERRBASE_UNKNOWN。
  // OPENSSL_MODULES 仅 Windows 需要（随包 legacy.dll）；Linux 用系统默认
  // ossl-modules 目录（legacy.so 在系统路径），设错会致 legacy 加载失败 → NLA 失败
  try {
    if (process.platform === 'win32') {
      const modulesDir = path.dirname(addonPath)
      process.env.OPENSSL_MODULES = modulesDir
    }
    const confPath = path.join(os.tmpdir(), 'zyxterm-openssl.cnf')
    if (!fs.existsSync(confPath)) {
      const conf = [
        'openssl_conf = openssl_init',
        '',
        '[openssl_init]',
        'providers = provider_sect',
        '',
        '[provider_sect]',
        'default = default_sect',
        'legacy = legacy_sect',
        '',
        '[default_sect]',
        'activate = 1',
        '',
        '[legacy_sect]',
        'activate = 1',
        ''
      ].join('\n')
      fs.writeFileSync(confPath, conf, 'utf8')
    }
    process.env.OPENSSL_CONF = confPath
    log('OPENSSL_MODULES=' + modulesDir + ' OPENSSL_CONF=' + confPath)
  } catch (e) {
    log('openssl conf err: ' + (e && e.message ? e.message : e))
  }
  let addon
  try {
    addon = require(addonPath)
  } catch (e) {
    log('addon load error: ' + (e && e.stack ? e.stack : e))
    send('error', 'FreeRDP 原生模块加载失败: ' + (e && e.message ? e.message : e))
    return
  }
  log('addon loaded')
  try {
    session = new addon.RdpSession(
      {
        host: config.host,
        port: config.port,
        username: config.username || '',
        password: config.password || '',
        domain: config.domain || '',
        width: config.width || 1280,
        height: config.height || 720
      },
      (type, payload) => {
        // 事件摘要（frame/pointer 只记尺寸，避免把巨大 Buffer 写入日志导致
        // 日志 I/O 阻塞 worker 线程，进而卡住 FreeRDP 事件循环导致连接断开）
        if (type === 'frame' && payload)
          log('event frame ' + payload.width + 'x' + payload.height)
        else if (type === 'pointer' && payload)
          log('event pointer ' + payload.width + 'x' + payload.height)
        else
          log('event ' + type + ' ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)))
        send(type, payload)
      }
    )
    log('RdpSession created')
    session.connect()
    log('connect() returned')
  } catch (e) {
    log('session error: ' + (e && e.stack ? e.stack : e))
    send('error', 'RDP 会话创建失败: ' + (e && e.message ? e.message : e))
  }
}

// parentPort 是 MessagePortMain：'message' 事件的回调参数是 MessageEvent，
// 实际消息在 event.data
process.parentPort.on('message', (e) => {
  const msg = e && e.data !== undefined ? e.data : e
  if (!msg || typeof msg !== 'object') return
  if (msg.cmd === 'init') {
    start(msg.config || {})
  } else if (msg.cmd === 'input' && session) {
    const i = msg.input || {}
    try {
      if (i.type === 'mouse') session.sendMouse(i.x || 0, i.y || 0, i.flags || 0)
      else if (i.type === 'key') session.sendKey(i.scancode || 0, !!i.pressed)
      else if (i.type === 'unicode') session.sendUnicode(i.code || 0, !!i.pressed)
    } catch (err) {
      send('error', '输入注入失败: ' + (err && err.message ? err.message : err))
    }
  }
})
// MessagePort 需显式 start 才开始接收主进程消息
try {
  process.parentPort.start()
} catch (e) {
  console.error('[rdp-worker] parentPort.start 失败:', e && e.message ? e.message : e)
}

// 兜底：捕获未处理异常（业务错误不崩溃进程；真正的崩溃仍由 OS 终止）
process.on('uncaughtException', (err) => {
  send('error', '未捕获异常: ' + (err && err.message ? err.message : err))
})
process.on('unhandledRejection', (err) => {
  send('error', '未处理拒绝: ' + (err && err.message ? err.message : err))
})

// 启动就绪信号：确保主进程收到后再发 init（避免 fork 后消息丢失）
setImmediate(() => {
  try {
    process.parentPort.postMessage({ type: 'ready' })
  } catch (e) {
    console.error('[rdp-worker] ready 发送失败:', e && e.message ? e.message : e)
  }
})
