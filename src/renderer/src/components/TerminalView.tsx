import { useCallback, useEffect, useRef, useState } from 'react'
import { uiAlert, uiConfirm } from '../dialogs'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  ProtocolType,
  SerialMacroScript,
  SerialMacroStatus,
  SshDirEntry,
  XmodemStatus
} from '@shared/types'
import { parseMacroScript } from '../macroParser'
import FileTree from './ssh/FileTree'
import CommandHistory from './ssh/CommandHistory'
import CommandCompletion from './ssh/CommandCompletion'
import QuickCommandBar, {
  QuickCommand,
  QuickCommandGroup
} from './ssh/QuickCommandBar'
import SerialMacroDialog from './SerialMacroDialog'
import SerialMacroProgress from './SerialMacroProgress'

interface Props {
  sessionId: string
  protocol: ProtocolType
  status: string
}

const QUICK_KEY = 'zyxterm:quick-commands'
/** 串口实时日志：上次使用的保存路径（持久化，下次开启默认填入） */
const SERIAL_LOG_KEY = 'zyxterm:serial-log-path'
/** XMODEM 发送：上次选中的文件路径（对话框下次默认定位到该目录/文件） */
const XMODEM_SEND_KEY = 'zyxterm:xmodem-send-path'
/** XMODEM 接收：上次保存的文件路径（对话框下次默认填入） */
const XMODEM_RECV_KEY = 'zyxterm:xmodem-recv-path'

/** POSIX 路径拼接 / 上级 */
function posixJoin(a: string, b: string): string {
  if (a === '/' || a === '') return '/' + b
  return a + '/' + b
}
function posixParent(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
/** POSIX 路径归一化（处理 . / ..） */
function posixNormalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** 字节数人性化显示 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function loadQuickGroups(): QuickCommandGroup[] {
  try {
    const raw = localStorage.getItem(QUICK_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as QuickCommandGroup[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 兼容旧格式（commands 为 string[]）
        return parsed.map((g) => ({
          ...g,
          commands: g.commands.map((c) =>
            typeof c === 'string' ? ({ cmd: c } as QuickCommand) : c
          )
        }))
      }
    }
  } catch {
    /* ignore */
  }
  // 无保存数据时默认为空（不预设默认类别/命令），由用户通过「✎ 编辑」自行添加
  return []
}

/** 基于 xterm.js 的终端视图。SSH 提供增强布局（文件树/历史/补全/快捷命令），串口为简洁终端 */
export default function TerminalView({ sessionId, protocol, status }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const isSsh = protocol === 'ssh'

  // 文件树浏览目录（独立于 SSH 目录；SSH cd 时同步重置，手动浏览不改变 SSH）
  const [cwd, setCwd] = useState<string | null>(null)
  const [entries, setEntries] = useState<SshDirEntry[]>([])
  const entriesRef = useRef<SshDirEntry[]>([])
  const setEntriesBoth = useCallback((list: SshDirEntry[]) => {
    entriesRef.current = list
    setEntries(list)
  }, [])

  // 历史 / 输入 / 补全
  const [history, setHistory] = useState<string[]>([])
  const [completion, setCompletion] = useState<string[]>([])
  const [completionIdx, setCompletionIdx] = useState(0)
  const [completionPos, setCompletionPos] = useState({ x: 0, y: 0 })
  const inputRef = useRef('')
  const historyRef = useRef<string[]>([])
  const completionRef = useRef<string[]>([])
  const completionIdxRef = useRef(0)
  const sessionIdRef = useRef(sessionId)

  // 快捷命令
  const [groups, setGroups] = useState<QuickCommandGroup[]>(loadQuickGroups)

  // 面板宽度（可通过与交互框相邻的分隔线拖动调节）
  const [treeW, setTreeW] = useState(220)
  const [histW, setHistW] = useState(200)
  const resizeRef = useRef<{ side: 'tree' | 'history'; startX: number; startW: number } | null>(null)

  const clampW = (v: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, v))

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>, side: 'tree' | 'history'): void => {
    e.preventDefault()
    resizeRef.current = {
      side,
      startX: e.clientX,
      startW: side === 'tree' ? treeW : histW
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const r = resizeRef.current
    if (!r) return
    const delta = e.clientX - r.startX
    if (r.side === 'tree') setTreeW(clampW(r.startW + delta, 150, 520))
    else setHistW(clampW(r.startW - delta, 150, 520))
  }

  const onResizeUp = (): void => {
    resizeRef.current = null
  }

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    try {
      localStorage.setItem(QUICK_KEY, JSON.stringify(groups))
    } catch {
      /* ignore */
    }
  }, [groups])

  // ---------- xterm 初始化 ----------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      scrollback: 10000,
      allowTransparency: true,
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term

    // SSH：选中文本即复制到剪贴板
    term.onSelectionChange(() => {
      if (!isSsh) return
      try {
        const sel = term.getSelection()
        if (sel) window.api.writeClipboard(sel)
      } catch {
        /* ignore */
      }
    })

    // 密码输入检测：SSH 中执行 sudo/su 等时 shell 提示输入密码，避免把密码
    // 误记录进命令历史/补全（安全）。检测输出中的密码提示符；出现普通提示符
    // （$ # >）时复位。
    let passwordModeRef = false
    const detectPasswordPrompt = (d: string): void => {
      const lower = d.toLowerCase()
      if (/password\s*:|passphrase\s*:|password for/i.test(lower)) {
        passwordModeRef = true
      } else if (/[\$#>]\s*$/.test(d)) {
        passwordModeRef = false
      }
    }
    const unsubData = window.api.onTerminalData((id, data) => {
      if (id === sessionIdRef.current) {
        term.write(data)
        detectPasswordPrompt(data)
      }
    })

    const onDataDisposable = term.onData((data) => {
      const sid = sessionIdRef.current
      if (!isSsh) {
        window.api.terminalWrite(sid, data)
        return
      }

      // 回车：密码输入模式下只发送回车（不提交历史/补全，避免记录密码）
      if (data === '\r') {
        if (passwordModeRef) {
          inputRef.current = ''
          window.api.terminalWrite(sid, data)
          return
        }
        const cands = completionRef.current
        if (cands.length > 0) {
          // 回车：把上下键/鼠标选中的命令补全到输入框（不执行）。
          // applyText 会把 inputRef 置为补全命令，用户可继续编辑或再次回车执行；
          // 因此这里不再清空 inputRef、不发送回车，保证“补全后能继续键盘输入”。
          applyCompletion(cands[completionIdxRef.current] ?? cands[0], false)
          setCompletionIdx(0)
          return
        }
        submitCurrentCommand()
        window.api.terminalWrite(sid, data)
        inputRef.current = ''
        setCompletion([])
        setCompletionIdx(0)
        return
      }
      // 上下键：补全导航
      if (data === '\x1b[A' || data === '\x1b[B') {
        const cands = completionRef.current
        if (cands.length > 0) {
          const dir = data === '\x1b[A' ? -1 : 1
          const next = (completionIdxRef.current + dir + cands.length) % cands.length
          completionIdxRef.current = next
          setCompletionIdx(next)
          return
        }
        window.api.terminalWrite(sid, data)
        return
      }
      // Tab：发送给 shell 做路径补全（shell 自身补全，清空我们的历史补全下拉避免干扰）
      if (data === '\t') {
        completionRef.current = []
        setCompletion([])
        setCompletionIdx(0)
        window.api.terminalWrite(sid, data)
        return
      }
      // 退格
      if (data === '\x7f') {
        if (!passwordModeRef) {
          inputRef.current = inputRef.current.slice(0, -1)
          updateCompletion(inputRef.current)
        }
        window.api.terminalWrite(sid, data)
        return
      }
      // 可见字符（含多字符粘贴）；排除控制字符/转义序列（如 \x1b...）。
      // 密码输入模式下不更新本地输入/补全（仅发送，避免密码进历史）
      if (data && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
        if (!passwordModeRef) {
          inputRef.current += data
          updateCompletion(inputRef.current)
        }
      }
      window.api.terminalWrite(sid, data)
    })

    const doFit = () => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
        window.api.terminalResize(sessionIdRef.current, term.cols, term.rows)
      })
    }
    const ro = new ResizeObserver(() => doFit())
    ro.observe(container)
    requestAnimationFrame(doFit)

    term.focus()

    return () => {
      ro.disconnect()
      unsubData()
      onDataDisposable.dispose()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // ---------- 文件树：初始化 + SSH 目录变化时同步 ----------
  useEffect(() => {
    if (!isSsh) return
    window.api.sshGetCwd(sessionId).then((c) => c && setCwd(c)).catch(() => {})
    window.api.sshListDir(sessionId)
      .then((r) => {
        setCwd(r.cwd || null)
        setEntriesBoth(r.entries)
      })
      .catch(() => {})
    // SSH 目录变化 → 文件夹跟随（重置浏览目录到 SSH 当前目录）
    const unsub = window.api.onSshCwdChanged((id, c) => {
      if (id === sessionId) {
        setCwd(c)
        window.api.sshListDir(sessionId)
          .then((r) => setEntriesBoth(r.entries))
          .catch(() => {})
      }
    })
    return unsub
  }, [isSsh, sessionId])

  // ---------- 命令 / 补全 / 快捷 ----------
  const submitCommand = useCallback((cmd: string) => {
    const c = cmd.trim()
    if (!c) return
    // 保留所有历史（不去重）：重复命令也逐条记录，避免“单击跳转到执行位置”因
    // 合并而错位/混乱
    setHistory((prev) => {
      const next = [c, ...prev].slice(0, 200)
      historyRef.current = next
      return next
    })
    window.api.sshCommand(sessionIdRef.current, c)
  }, [])

  /** 右击粘贴：读取剪贴板并写入终端；若含换行则弹窗确认 */
  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      if (!isSsh) return
      e.preventDefault()
      try {
        const text = await window.api.readClipboard()
        if (!text) return
        if (/[\r\n]/.test(text)) {
          const preview = text.length > 1000 ? text.slice(0, 1000) + '…' : text
          const ok = await uiConfirm(`剪贴板内容包含换行，确认粘贴？\n\n${preview}`)
          if (!ok) return
        }
        window.api.terminalWrite(sessionIdRef.current, text)
      } catch {
        /* ignore */
      }
    },
    [isSsh]
  )

  /** 提交当前命令：从终端 buffer 光标行（当前输入行）提取完整命令（含 shell 补全），失败回退输入缓冲 */
  const submitCurrentCommand = useCallback(() => {
    const term = termRef.current
    let cmd = inputRef.current.trim()
    if (term) {
      try {
        const buffer = term.buffer.active
        // 光标所在行即当前输入行（shell 补全后的完整命令）
        const line = buffer.getLine(buffer.baseY + buffer.cursorY)
        if (line) {
          const text = line.translateToString(true)
          // 取提示符（$ 或 #）之后的命令文本
          const m = text.match(/(?:[$#])\s*([^$\r\n#]+?)\s*$/)
          if (m && m[1].trim()) cmd = m[1].trim()
        }
      } catch {
        /* ignore */
      }
    }
    submitCommand(cmd)
  }, [submitCommand])

  const updateCompletion = useCallback((input: string) => {
    if (!input.trim()) {
      completionRef.current = []
      setCompletion([])
      return
    }
    // 候选去重（历史含重复命令时避免下拉出现重复项）
    const matches = Array.from(
      new Set(
        historyRef.current.filter((h) => h.startsWith(input) && h !== input)
      )
    ).slice(0, 8)
    completionRef.current = matches
    setCompletion(matches)
    setCompletionIdx(0)
    completionIdxRef.current = 0
    if (matches.length > 0) {
      // 定位到当前输入光标下方：xterm 的隐藏 textarea 跟随光标，其屏幕坐标即
      // 光标位置；避免补全下拉固定在左上角遮挡输入（导致空格等输入“无效”）
      const ta = termRef.current?.element?.querySelector<HTMLElement>(
        '.xterm-helper-textarea'
      )
      const r = ta?.getBoundingClientRect()
      if (r) {
        setCompletionPos({ x: r.left, y: r.bottom + 4 })
      }
    }
  }, [])

  /** 将文本写入当前输入行：只发 shell（靠 shell 回显），避免本地+回显双份 */
  const applyText = useCallback((text: string) => {
    const sid = sessionIdRef.current
    const prevLen = inputRef.current.length
    window.api.terminalWrite(sid, '\x7f'.repeat(prevLen) + text)
    inputRef.current = text
    setCompletion([])
    completionRef.current = []
  }, [])

  const applyCompletion = useCallback(
    (cmd: string, exec: boolean) => {
      applyText(cmd)
      if (exec) {
        submitCommand(cmd)
        window.api.terminalWrite(sessionIdRef.current, '\r')
      }
      setCompletion([])
    },
    [applyText, submitCommand]
  )


  // ---------- 文件树浏览（不改变 SSH 目录） ----------
  const browse = useCallback(async (path: string) => {
    try {
      const r = await window.api.sshListDir(sessionIdRef.current, path)
      setCwd(r.cwd || path)
      setEntriesBoth(r.entries)
    } catch {
      /* ignore */
    }
  }, [setEntriesBoth])

  const cdTo = useCallback(
    (name: string) => {
      void browse(posixJoin(cwd ?? '/', name))
    },
    [browse, cwd]
  )

  const goUp = useCallback(() => {
    void browse(posixParent(cwd ?? '/'))
  }, [browse, cwd])

  const refreshDir = useCallback(() => {
    void browse(cwd ?? '/')
  }, [browse, cwd])

  const manualCd = useCallback(
    (path: string) => {
      void browse(path)
    },
    [browse]
  )

  // ---------- 下载 / 上传 ----------
  const handleDownload = useCallback(
    async (entry: SshDirEntry) => {
      const remote = posixJoin(cwd ?? '/', entry.name)
      const res = await window.api.sshDownload(sessionIdRef.current, remote)
      if (!res.saved && res.error) void uiAlert(`下载失败: ${res.error}`)
    },
    [cwd]
  )

  const handleUpload = useCallback(
    async (file: File) => {
      const localPath = window.api.getPathForFile(file)
      const remote = posixJoin(cwd ?? '/', file.name)
      const res = await window.api.sshUpload(sessionIdRef.current, remote, localPath)
      if (!res.ok) void uiAlert(`上传失败: ${res.error}`)
      else void refreshDir()
    },
    [cwd, refreshDir]
  )

  // ---------- 历史跳转 / 重跑 ----------
  const jumpToHistory = useCallback((cmd: string) => {
    const term = termRef.current
    if (!term) return
    const buffer = term.buffer.active
    for (let y = buffer.length - 1; y >= 0; y--) {
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      if (text.includes(cmd)) {
        const row = y - buffer.baseY
        term.scrollLines(row - buffer.viewportY)
        term.selectLines(row, row)
        break
      }
    }
  }, [])

  const rerunCommand = useCallback(
    (cmd: string) => {
      window.api.terminalWrite(sessionIdRef.current, cmd + '\r')
      submitCommand(cmd)
    },
    [submitCommand]
  )

  // ---------- 快捷命令 ----------
  const runQuick = useCallback(
    (cmd: string) => {
      // 直接发给 shell（回显一次），不再本地写入
      window.api.terminalWrite(sessionIdRef.current, cmd + '\r')
      submitCommand(cmd)
    },
    [submitCommand]
  )

  // ---------- 串口 XMODEM 文件传输 ----------
  const isSerial = protocol === 'serial'
  const [xmodem, setXmodem] = useState<XmodemStatus | null>(null)
  // 接收文件时设备端 sz 发送方不传文件名，用系统时间兜底命名提示
  const xmodemActive =
    xmodem !== null && (xmodem.state === 'started' || xmodem.state === 'progress')

  useEffect(() => {
    if (!isSerial) return
    const unsub = window.api.onSerialXmodemStatus((id, st) => {
      if (id !== sessionIdRef.current) return
      if (st.state === 'done' || st.state === 'error' || st.state === 'cancel') {
        // 结果状态短暂展示后隐藏
        setXmodem({ ...st })
        window.setTimeout(() => setXmodem(null), 6000)
      } else {
        setXmodem(st)
      }
    })
    return unsub
  }, [isSerial, sessionId])

  const handleXmodemSend = useCallback(async (): Promise<void> => {
    try {
      let last: string | null = null
      try {
        last = localStorage.getItem(XMODEM_SEND_KEY)
      } catch {
        /* ignore */
      }
      const res = await window.api.serialXmodemSend(sessionIdRef.current, last ?? undefined)
      if (!res.ok) {
        if (res.error && res.error !== '已取消') void uiAlert(res.error)
        return
      }
      // 持久化本次选中的路径，下次打开默认定位到该路径
      if (res.path) {
        try {
          localStorage.setItem(XMODEM_SEND_KEY, res.path)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleXmodemReceive = useCallback(async (): Promise<void> => {
    try {
      let last: string | null = null
      try {
        last = localStorage.getItem(XMODEM_RECV_KEY)
      } catch {
        /* ignore */
      }
      const res = await window.api.serialXmodemReceive(sessionIdRef.current, last ?? undefined)
      if (!res.ok) {
        if (res.error && res.error !== '已取消') void uiAlert(res.error)
        return
      }
      if (res.path) {
        try {
          localStorage.setItem(XMODEM_RECV_KEY, res.path)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, [])

  const handleXmodemCancel = useCallback((): void => {
    window.api.serialXmodemCancel(sessionIdRef.current)
  }, [])

  // ---------- 串口实时日志 ----------
  const [serialLog, setSerialLog] = useState<{ logging: boolean; path?: string }>({
    logging: false
  })

  useEffect(() => {
    if (!isSerial) return
    // 初始与主进程当前记录状态同步（如重开界面/切回 tab）
    window.api
      .serialLogState(sessionIdRef.current)
      .then((st) => setSerialLog(st))
      .catch(() => {})
    const unsub = window.api.onSerialLogStatus((id, st) => {
      if (id === sessionIdRef.current) setSerialLog(st)
    })
    return unsub
  }, [isSerial, sessionId])

  // ---------- 串口自动化脚本 ----------
  const [macroEditorOpen, setMacroEditorOpen] = useState(false)
  const [macroProgressOpen, setMacroProgressOpen] = useState(false)
  const [macroStatus, setMacroStatus] = useState<SerialMacroStatus | null>(null)
  const [runningMacro, setRunningMacro] = useState<SerialMacroScript | null>(null)

  useEffect(() => {
    if (!isSerial) return
    const unsub = window.api.onSerialMacroStatus((id, st) => {
      if (id === sessionIdRef.current) setMacroStatus(st)
    })
    return unsub
  }, [isSerial, sessionId])

  /** 运行脚本：解析 → 记录运行脚本 → 自动弹出进度页 → 交给主进程执行 */
  const runMacro = useCallback(async (script: SerialMacroScript): Promise<void> => {
    const { steps, error } = parseMacroScript(script.text)
    if (error || steps.length === 0) {
      void uiAlert(error || '脚本为空')
      return
    }
    setRunningMacro(script)
    setMacroEditorOpen(false)
    setMacroProgressOpen(true)
    const res = await window.api.serialMacroStart(sessionIdRef.current, {
      steps,
      loop: script.loop
    })
    if (!res.ok) {
      void uiAlert(res.error ?? '启动失败')
      setRunningMacro(null)
      setMacroProgressOpen(false)
    }
  }, [])

  /** 停止自动化脚本 */
  const stopMacro = useCallback((): void => {
    window.api.serialMacroStop(sessionIdRef.current)
  }, [])

  const toggleSerialLog = useCallback(async (): Promise<void> => {
    try {
      if (serialLog.logging) {
        await window.api.serialLogStop(sessionIdRef.current)
        return
      }
      // 上次保存路径持久化：下次开启默认填入
      let last: string | null = null
      try {
        last = localStorage.getItem(SERIAL_LOG_KEY)
      } catch {
        /* ignore */
      }
      const res = await window.api.serialLogStart(sessionIdRef.current, last ?? undefined)
      if (!res.ok) {
        if (res.error && res.error !== '已取消') void uiAlert(res.error)
        return
      }
      if (res.path) {
        try {
          localStorage.setItem(SERIAL_LOG_KEY, res.path)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, [serialLog.logging])

  if (!isSsh) {
    const pct = xmodem && xmodem.total
      ? Math.min(100, Math.round(((xmodem.sent ?? 0) / xmodem.total) * 100))
      : 0
    const resultText = ((): string => {
      if (!xmodem) return ''
      switch (xmodem.state) {
        case 'done':
          return xmodem.mode === 'recv'
            ? `接收完成：${xmodem.savePath ?? ''}`
            : `发送完成：${xmodem.name ?? ''}`
        case 'error':
          return `失败：${xmodem.message ?? '未知错误'}`
        case 'cancel':
          return '已取消'
        default:
          return ''
      }
    })()
    return (
      <div className="serial-layout">
        <div className="serial-toolbar">
          <span className="serial-toolbar-title">串口传输</span>
          <button
            className="tool-btn"
            onClick={() => void handleXmodemSend()}
            disabled={xmodemActive}
            title="将本地文件通过 XMODEM 发给设备（对端先执行 rx 接收）"
          >
            ⬆ 发送文件 (XMODEM)
          </button>
          <button
            className="tool-btn"
            onClick={() => void handleXmodemReceive()}
            disabled={xmodemActive}
            title="从设备经 XMODEM 接收文件到本地（对端先执行 sz 发送）"
          >
            ⬇ 接收文件 (XMODEM)
          </button>
          {xmodemActive && (
            <button className="tool-btn danger" onClick={handleXmodemCancel}>
              取消传输
            </button>
          )}
          <div className="serial-toolbar-right">
            {!xmodemActive && resultText && (
              <span className={`xmodem-result ${xmodem?.state ?? ''}`}>{resultText}</span>
            )}
            {macroStatus?.running && runningMacro ? (
              <span className="macro-run-group">
                {/* 主体：点开进度页；右侧小图标：停止 */}
                <button
                  className="tool-btn macro-run-main"
                  onClick={() => setMacroProgressOpen(true)}
                  title={macroStatus.message ?? '查看自动化进度'}
                >
                  ▶ {runningMacro.name || '脚本'} 第{macroStatus.iter}轮 步骤
                  {Math.min(macroStatus.idx + 1, macroStatus.total)}/{macroStatus.total}
                </button>
                <button
                  className="tool-btn danger macro-run-stop"
                  title="停止自动化"
                  onClick={stopMacro}
                >
                  ⏹
                </button>
              </span>
            ) : (
              <button
                className="tool-btn"
                onClick={() => setMacroEditorOpen(true)}
                title="串口自动化脚本（TX 发送 / RX 等待输出 / SLEEP 延时，可循环）"
              >
                🛠 自动化
              </button>
            )}
            <button
              className={`tool-btn${serialLog.logging ? ' active' : ''}`}
              onClick={() => void toggleSerialLog()}
              title={
                serialLog.logging
                  ? '正在实时保存串口日志，点击停止'
                  : '开启实时保存串口日志（可自定义路径与文件名；下次开启默认填入上次路径）'
              }
            >
              {serialLog.logging ? '■ 停止日志' : '📝 记录日志'}
            </button>
            {serialLog.logging && serialLog.path && (
              <span className="serial-log-path" title={serialLog.path}>
                {serialLog.path}
              </span>
            )}
          </div>
        </div>
        {xmodemActive && (
          <div className="xmodem-panel">
            <div className="xmodem-meta">
              <span className="xmodem-name">
                {xmodem.mode === 'send'
                  ? `发送 ${xmodem.name ?? ''}`
                  : `接收文件`}
              </span>
              <span className="xmodem-dir">
                {xmodem.mode === 'send'
                  ? xmodem.total
                    ? `${pct}% (${formatBytes(xmodem.sent ?? 0)} / ${formatBytes(xmodem.total)})`
                    : '发送中…'
                  : `已接收 ${formatBytes(xmodem.sent ?? 0)}`}
              </span>
            </div>
            <div className="xmodem-bar">
              <div
                className={`xmodem-fill${xmodem.total ? '' : ' indeterminate'}`}
                style={xmodem.total ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        )}
        <div className="terminal-wrap">
          <div className="terminal-container" ref={containerRef} />
        </div>
        {macroEditorOpen && (
          <SerialMacroDialog
            onRun={(s) => void runMacro(s)}
            onClose={() => setMacroEditorOpen(false)}
          />
        )}
        {macroProgressOpen && runningMacro && (
          <SerialMacroProgress
            script={runningMacro}
            status={macroStatus}
            onStop={stopMacro}
            onClose={() => setMacroProgressOpen(false)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="ssh-layout">
      <div className="ssh-row">
        <FileTree
          style={{ width: treeW, flex: '0 0 auto' }}
          cwd={cwd}
          entries={entries}
          onCd={cdTo}
          onGoUp={goUp}
          onRefresh={refreshDir}
          onManualCd={manualCd}
          onDownload={handleDownload}
          onUploadDrop={handleUpload}
        />
        <div
          className="resize-handle"
          title="拖动调整宽度"
          onPointerDown={(e) => onResizeDown(e, 'tree')}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <div className="ssh-main">
          <div className="terminal-wrap ssh-terminal">
            <div className="terminal-container" ref={containerRef} onContextMenu={handleContextMenu} />
            <CommandCompletion
              items={completion}
              index={completionIdx}
              x={completionPos.x}
              y={completionPos.y}
              onSelect={applyCompletion}
            />
          </div>
        </div>
        <div
          className="resize-handle"
          title="拖动调整宽度"
          onPointerDown={(e) => onResizeDown(e, 'history')}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
        <CommandHistory
          style={{ width: histW, flex: '0 0 auto' }}
          history={history}
          onJump={jumpToHistory}
          onRun={rerunCommand}
        />
      </div>
      {/* 底部快捷命令栏：贯穿文件/交互/历史三列下方 */}
      <QuickCommandBar groups={groups} onRun={runQuick} onUpdate={setGroups} />
    </div>
  )
}
