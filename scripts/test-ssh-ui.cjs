#!/usr/bin/env node
/**
 * SSH 增强视图端到端测试：
 * - 布局：左文件树 / 终端 / 右历史 / 底部快捷命令栏
 * - 文件树：显示目录、点击进入（ssh:cd）、目录同步
 * - 快捷命令：点击按钮键入命令 → 历史记录 + 终端写入
 */
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

// ---------- 路径补全算法（与 renderer 的 computePathCompletion 保持一致） ----------
function computePathCompletion(input, entries) {
  const sp = input.lastIndexOf(' ')
  const last = sp >= 0 ? input.slice(sp + 1) : input
  if (!last || last.startsWith('-')) return null
  const slash = last.lastIndexOf('/')
  const dirPart = slash >= 0 ? last.slice(0, slash + 1) : ''
  const prefix = slash >= 0 ? last.slice(slash + 1) : last
  if (!prefix) return null
  const base = sp >= 0 ? input.slice(0, sp + 1) : ''
  const matches = entries.filter((e) => e.name.startsWith(prefix))
  if (matches.length === 1) {
    const m = matches[0]
    return base + dirPart + m.name + (m.type === 'dir' ? '/' : '')
  }
  if (matches.length > 1) {
    return matches.map((m) => base + dirPart + m.name + (m.type === 'dir' ? '/' : ''))
  }
  return null
}
console.log('[test] pc case1:', computePathCompletion('cd pr', [
  { name: 'project', type: 'dir' }, { name: 'etc', type: 'dir' }
]))
console.log('[test] pc case2:', computePathCompletion('cd project/F', [
  { name: 'FPGA', type: 'dir' }, { name: 'rtl', type: 'dir' }
]))
console.log('[test] pc case3:', computePathCompletion('ls /e', [
  { name: 'etc', type: 'dir' }
]))
console.log('[test] pc case4:', computePathCompletion('cd v', [
  { name: 'var', type: 'dir' }, { name: 'vmlinuz', type: 'file' }
]))

// 提交时「光标行提取命令」正则（与 renderer submitCurrentCommand 一致）
function extractCmd(text) {
  const m = text.match(/(?:[$#])\s*([^$\r\n#]+?)\s*$/)
  return m && m[1].trim() ? m[1].trim() : null
}
console.log('[test] ex1:', extractCmd('ubuser@host:/home/ubuser$ cd project/FPGA'))
console.log('[test] ex2:', extractCmd('[user@host ~]# ls -la'))
console.log('[test] ex3:', extractCmd('cd project/FPGA'))

// cd - 回上一目录（与 renderer/主进程 resolveCd + oldPwd 逻辑一致）
function resolveCd(current, arg, home, oldPwd) {
  if (arg === '-') return oldPwd || current
  if (!arg || arg === '~') return home || '/'
  if (arg.startsWith('/')) return '/' + arg.split('/').filter(Boolean).join('/')
  if (arg.startsWith('~/')) return home + '/' + arg.slice(2)
  const out = []
  for (const part of (current + '/' + arg).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}
;(() => {
  let cwd = '/home/ubuser/project'
  let oldPwd = null
  let target = resolveCd(cwd, 'FPGA', '/home/ubuser', oldPwd)
  if (cwd !== target) oldPwd = cwd
  cwd = target
  console.log('[test] cd- step1:', cwd, 'old:', oldPwd)
  target = resolveCd(cwd, '-', '/home/ubuser', oldPwd)
  if (cwd !== target) oldPwd = cwd
  cwd = target
  console.log('[test] cd- step2 (cd -):', cwd, 'old:', oldPwd)
})()

// PROMPT_COMMAND 标记段过滤/提取（与主进程 onData 一致）
const MARK_S = '\x01ZYTPWD\x02'
const MARK_E = '\x01ZYTEND\x02'
function promptFilter(data, state) {
  state.buf += data
  let out = ''
  while (state.buf.length) {
    const start = state.buf.indexOf(MARK_S)
    if (start < 0) {
      out += state.buf
      state.buf = ''
      break
    }
    out += state.buf.slice(0, start)
    const end = state.buf.indexOf(MARK_E, start)
    if (end < 0) {
      state.buf = state.buf.slice(start)
      break
    }
    state.cwd = state.buf.slice(start + MARK_S.length, end).trim()
    state.buf = state.buf.slice(end + MARK_E.length)
  }
  return out
}
;(() => {
  const st = { buf: '', cwd: null }
  const out = promptFilter(
    MARK_S + '/home/ubuser/project' + MARK_E + 'ubuser@host:/home/ubuser/project$ ',
    st
  )
  console.log('[test] prompt cwd:', st.cwd)
  console.log('[test] prompt out(filtered):', JSON.stringify(out))
})()

const cmdLog = []
const writeLog = []
let cwdState = '/home/user'

const dirEntries = (path) => {
  if (path && path.includes('project')) {
    return [
      { name: 'FPGA', type: 'dir', size: 4096, mtime: 'Mar 20 10:00' },
      { name: 'rtl', type: 'dir', size: 4096, mtime: 'Mar 20 10:00' }
    ]
  }
  return [
    { name: 'project', type: 'dir', size: 4096, mtime: 'Mar 20 10:00' },
    { name: 'etc', type: 'dir', size: 4096, mtime: 'Mar 20 10:00' },
    { name: 'file.txt', type: 'file', size: 123, mtime: 'Mar 20 09:00' }
  ]
}

// ---------- IPC 桩 ----------
ipcMain.handle('session:create', () => ({
  sessionId: 'ssh1',
  profileId: 'x',
  name: 'SSH测试',
  protocol: 'ssh',
  status: 'connected'
}))
ipcMain.handle('session:list', () => [])
ipcMain.handle('session:close', () => {})
ipcMain.handle('profiles:list', () => [
  {
    id: 'p1',
    name: 'SSH测试',
    protocol: 'ssh',
    ssh: { host: '127.0.0.1', port: 22, username: 'user', authType: 'password', password: '' },
    createdAt: 0
  }
])
ipcMain.handle('profiles:save', () => ({ id: 'x' }))
ipcMain.handle('profiles:update', () => ({}))
ipcMain.handle('profiles:delete', () => true)
ipcMain.handle('vnc:endpoint', () => null)
ipcMain.handle('clipboard:read', () => '')
ipcMain.handle('clipboard:write', () => {})
ipcMain.handle('rdp:detect', () => ({ available: false }))
ipcMain.handle('serial:list', () => [])
ipcMain.handle('dialog:selectFile', () => null)

ipcMain.handle('ssh:getCwd', () => cwdState)
ipcMain.handle('ssh:listDir', (_e, _id, p) => ({ cwd: p || cwdState, entries: dirEntries(p) }))
ipcMain.handle('ssh:cd', (_e, _id, p) => {
  cwdState = cwdState + '/' + p
  return { cwd: cwdState, entries: dirEntries() }
})
ipcMain.on('ssh:command', (_e, _id, cmd) => cmdLog.push(cmd))
ipcMain.on('terminal:write', (_e, _id, data) => writeLog.push(data))
ipcMain.on('terminal:resize', () => {})
const downloadLog = []
const uploadLog = []
ipcMain.handle('ssh:download', (_e, _id, remotePath) => {
  downloadLog.push(remotePath)
  return { saved: true, path: '/tmp/x' }
})
ipcMain.handle('ssh:upload', (_e, _id, remotePath, localPath) => {
  uploadLog.push({ remotePath, localPath })
  return { ok: true }
})
ipcMain.on('window:register', () => {})
ipcMain.on('tabs:changed', () => {})

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 1500))
  // 清除可能残留的快捷命令数据，验证「默认为空」的干净初始状态
  await win.webContents.executeJavaScript(
    `localStorage.removeItem('zyxterm:quick-commands'); 'CLEARED'`
  )

  // 双击首页 SSH 配置
  await win.webContents
    .executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.grid-col .profile-item')]
      const item = items.find((el) => el.querySelector('.profile-name')?.textContent === 'SSH测试') || items[0]
      if (!item) return 'NO_ITEM'
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return 'DBL'
    })()`)
    .then((r) => console.log('[test] open ssh:', r))
  await new Promise((r) => setTimeout(r, 1500))

  // 布局 + 文件树
  console.log(
    '[test] layout:',
    await win.webContents.executeJavaScript(
      `(() => ({
        sshLayout: !!document.querySelector('.ssh-layout'),
        fileTree: !!document.querySelector('.file-tree'),
        history: !!document.querySelector('.cmd-history'),
        quickBar: !!document.querySelector('.quick-bar'),
        fileItems: document.querySelectorAll('.file-item').length,
        cwd: document.querySelector('.file-tree-cwd input')?.value
      }))()`
    )
  )

  // 点击目录进入 → ssh:cd
  await win.webContents.executeJavaScript(
    `(() => { const d = document.querySelector('.file-item.dir'); if (d) d.click(); return 'CLICKED' })()`
  )
  await new Promise((r) => setTimeout(r, 500))
  console.log(
    '[test] after dir click:',
    await win.webContents.executeJavaScript(`document.querySelector('.file-tree-cwd input')?.value`)
  )

  // 快捷命令：默认为空（无默认类别/命令），显示空提示
  console.log(
    '[test] quick groups (empty default):',
    await win.webContents.executeJavaScript(
      `(() => ({
        editBtn: !!document.querySelector('.quick-edit-btn'),
        blocks: document.querySelectorAll('.quick-group-block').length,
        cmdBtns: document.querySelectorAll('.quick-cmd-btn').length,
        empty: !!document.querySelector('.quick-empty')
      }))()`
    )
  )

  // 编辑弹窗：添加类别「测试」+ 命令 pwd 并保存
  await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.quick-edit-btn'); if (b) b.click(); return true })()`
  )
  await new Promise((r) => setTimeout(r, 300))
  console.log(
    '[test] edit dialog:',
    await win.webContents.executeJavaScript(
      `!!document.querySelector('.quick-edit-dialog') + ' qe-groups=' + document.querySelectorAll('.qe-group').length + ' qe-cmds=' + document.querySelectorAll('.qe-cmd').length`
    )
  )
  await win.webContents.executeJavaScript(`(() => {
    const addG = document.querySelector('.qe-add-group')
    if (!addG) return 'NO_ADD_GROUP'
    addG.click()
    return 'ADD_GROUP'
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  await win.webContents.executeJavaScript(`(() => {
    const setVal = (el, val) => {
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setVal(document.querySelector('.qe-name'), '测试')
    const addC = document.querySelector('.qe-add-cmd')
    if (addC) addC.click()
    return 'ADD_CMD'
  })()`)
  await new Promise((r) => setTimeout(r, 200))
  await win.webContents.executeJavaScript(`(() => {
    const setVal = (el, val) => {
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const cmdInput = [...document.querySelectorAll('.qe-cmd input')].find((el) => el.placeholder === '命令')
    setVal(cmdInput, 'pwd')
    const save = document.querySelector('.dialog-footer .primary')
    if (save) save.click()
    return 'SAVED'
  })()`)
  await new Promise((r) => setTimeout(r, 400))

  // 添加后平铺显示
  console.log(
    '[test] quick after add:',
    await win.webContents.executeJavaScript(
      `(() => ({
        blocks: document.querySelectorAll('.quick-group-block').length,
        names: [...document.querySelectorAll('.quick-group-name')].map((n) => n.textContent),
        cmdBtns: document.querySelectorAll('.quick-cmd-btn').length,
        cmdTexts: [...document.querySelectorAll('.quick-cmd-btn')].map((n) => n.textContent)
      }))()`
    )
  )

  // 快捷命令：点击第一个按钮 → 历史 + 终端写入
  await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('.quick-cmd-btn'); if (b) b.click(); return 'CLICKED' })()`
  )
  await new Promise((r) => setTimeout(r, 500))
  console.log(
    '[test] after quick:',
    await win.webContents.executeJavaScript(
      `(() => ({
        historyItems: document.querySelectorAll('.cmd-history-item').length,
        historyFirst: document.querySelector('.cmd-history-item')?.textContent
      }))()`
    )
  )
  console.log('[test] quick write tail:', JSON.stringify(writeLog.slice(-3)))
  console.log('[test] ssh:command log:', JSON.stringify(cmdLog))
  console.log(
    '[test] quick write count(cmd):',
    writeLog.filter((w) => w === 'pwd').length
  )
  console.log(
    '[test] writeLog has cd:',
    writeLog.some((w) => String(w).trim().startsWith('cd'))
  )

  // 双击文件 → 下载
  await win.webContents
    .executeJavaScript(`(() => {
      const f = [...document.querySelectorAll('.file-item.file')].find((el) => el.textContent.includes('file.txt'))
      if (!f) return 'NO_FILE'
      f.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return 'DBL'
    })()`)
    .then((r) => console.log('[test] dbl file:', r))
  await new Promise((r) => setTimeout(r, 300))
  console.log('[test] downloadLog:', JSON.stringify(downloadLog))

  // 目录同步：主进程推送 cwd 变化（如用户在终端执行 cd）→ 文件树刷新
  win.webContents.send('ssh:cwd-changed', 'ssh1', '/opt/project')
  await new Promise((r) => setTimeout(r, 600))
  console.log(
    '[test] after cwd sync:',
    await win.webContents.executeJavaScript(
      `document.querySelector('.file-tree-cwd input')?.value`
    )
  )

  // 可拖动分隔线：存在两个 handle，模拟拖动文件树右缘改变宽度
  console.log(
    '[test] resize handles:',
    await win.webContents.executeJavaScript(
      `(() => ({
        count: document.querySelectorAll('.resize-handle').length,
        treeW: document.querySelector('.file-tree')?.style.width,
        histW: document.querySelector('.cmd-history')?.style.width
      }))()`
    )
  )
  await win.webContents.executeJavaScript(`(() => {
    const h = document.querySelectorAll('.resize-handle')[0]
    if (!h) return 'NO_HANDLE'
    h.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, bubbles: true, cancelable: true }))
    h.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 160, bubbles: true, cancelable: true }))
    h.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 160, bubbles: true, cancelable: true }))
    return 'DRAG'
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  console.log(
    '[test] treeW after drag:',
    await win.webContents.executeJavaScript(`document.querySelector('.file-tree')?.style.width`)
  )

  app.exit(0)
})
