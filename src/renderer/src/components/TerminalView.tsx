import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ProtocolType, SshDirEntry } from '@shared/types'
import FileTree from './ssh/FileTree'
import CommandHistory from './ssh/CommandHistory'
import CommandCompletion from './ssh/CommandCompletion'
import QuickCommandBar, {
  QuickCommand,
  QuickCommandGroup
} from './ssh/QuickCommandBar'

interface Props {
  sessionId: string
  protocol: ProtocolType
  status: string
}

const QUICK_KEY = 'zyxterm:quick-commands'

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

    const unsubData = window.api.onTerminalData((id, data) => {
      if (id === sessionIdRef.current) term.write(data)
    })

    const onDataDisposable = term.onData((data) => {
      const sid = sessionIdRef.current
      if (!isSsh) {
        window.api.terminalWrite(sid, data)
        return
      }

      // 回车：有补全候选则选择执行，否则提交
      if (data === '\r') {
        const cands = completionRef.current
        if (cands.length > 0) {
          applyCompletion(cands[completionIdxRef.current] ?? cands[0], true)
        } else {
          submitCurrentCommand()
          window.api.terminalWrite(sid, data)
        }
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
        inputRef.current = inputRef.current.slice(0, -1)
        updateCompletion(inputRef.current)
        window.api.terminalWrite(sid, data)
        return
      }
      // 可见字符（含多字符粘贴）；排除控制字符/转义序列（如 \x1b...）
      if (data && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
        inputRef.current += data
        updateCompletion(inputRef.current)
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
    setHistory((prev) => {
      const next = [c, ...prev.filter((h) => h !== c)].slice(0, 200)
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
          const ok = window.confirm(`剪贴板内容包含换行，确认粘贴？\n\n${preview}`)
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
    const matches = historyRef.current
      .filter((h) => h.startsWith(input) && h !== input)
      .slice(0, 8)
    completionRef.current = matches
    setCompletion(matches)
    setCompletionIdx(0)
    completionIdxRef.current = 0
    if (matches.length > 0 && containerRef.current) {
      const r = containerRef.current.getBoundingClientRect()
      setCompletionPos({ x: r.left + 8, y: r.top + 8 })
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
      if (!res.saved && res.error) alert(`下载失败: ${res.error}`)
    },
    [cwd]
  )

  const handleUpload = useCallback(
    async (file: File) => {
      const localPath = window.api.getPathForFile(file)
      const remote = posixJoin(cwd ?? '/', file.name)
      const res = await window.api.sshUpload(sessionIdRef.current, remote, localPath)
      if (!res.ok) alert(`上传失败: ${res.error}`)
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

  if (!isSsh) {
    return (
      <div className="terminal-wrap">
        <div className="terminal-container" ref={containerRef} />
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
