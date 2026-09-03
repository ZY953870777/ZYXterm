import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  GlobalMacroScript,
  GlobalMacroStep,
  GlobalMacroTarget
} from '@shared/types'
import { parseGlobalMacro } from '../globalMacroParser'
import { uiAlert } from '../dialogs'

const GM_SCRIPTS_KEY = 'zyxterm:global-macros'
const GM_TARGETS_KEY = 'zyxterm:global-targets'
// 每个联动脚本各自记住的上次参与连接（scriptId -> profileId 顺序）
const GM_SCRIPT_TARGETS_KEY = 'zyxterm:gm-script-targets'

const GM_SAMPLE = `# 联动示例：SSH(0) 发命令，串口1(1) 等待结果
TX0 "run test"
RX1 "Ready>"
sleep 10
TX1 "test"`

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function loadScripts(): GlobalMacroScript[] {
  try {
    const raw = localStorage.getItem(GM_SCRIPTS_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as GlobalMacroScript[]
      if (Array.isArray(arr)) return arr.filter((s) => s && typeof s.id === 'string')
    }
  } catch {
    /* ignore */
  }
  return [{ id: uid(), name: '联动示例', text: GM_SAMPLE, loop: 1 }]
}

function loadTargetProfileIds(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(GM_TARGETS_KEY) ?? '[]') as string[]
    if (Array.isArray(arr)) return arr
  } catch {
    /* ignore */
  }
  return []
}

/** 每个联动脚本各自记住的上次参与连接（profileId 顺序；不随脚本删除外泄） */
type TargetMemMap = Record<string, string[]>

function loadScriptTargetMap(): TargetMemMap {
  try {
    const o = JSON.parse(localStorage.getItem(GM_SCRIPT_TARGETS_KEY) ?? '{}') as unknown
    if (o && typeof o === 'object') return o as TargetMemMap
  } catch {
    /* ignore */
  }
  return {}
}

function saveScriptTargetMap(map: TargetMemMap): void {
  try {
    localStorage.setItem(GM_SCRIPT_TARGETS_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

interface Props {
  onRun: (targets: GlobalMacroTarget[], script: GlobalMacroScript) => void
  onClose: () => void
}

export default function GlobalMacroDialog({ onRun, onClose }: Props) {
  const [avail, setAvail] = useState<GlobalMacroTarget[]>([])
  const [chosen, setChosen] = useState<GlobalMacroTarget[]>([])
  const [scripts, setScripts] = useState<GlobalMacroScript[]>(loadScripts)
  const [selId, setSelId] = useState<string | null>(null)
  const dragRef = useRef<{ from: 'avail' | 'chosen'; profileId: string } | null>(null)
  // 当前右侧列表代表哪个脚本（切换脚本时把记忆落回各自脚本，避免串写）
  const activeScriptRef = useRef<string | null>(null)
  // 打开对话框时可用列表尚未就绪前，暂存待填充记忆的脚本 id
  const pendingSeedRef = useRef<string | null>(null)

  /** 某脚本记住的连接顺序；键存在即按存储（含空=用户已清空），键不存在才回退“全局上次” */
  const memOf = (id: string): string[] => {
    const map = loadScriptTargetMap()
    if (Object.prototype.hasOwnProperty.call(map, id)) return map[id] ?? []
    return loadTargetProfileIds()
  }

  /** 把连接顺序固化到指定脚本记忆，并同步“全局上次”供回退 */
  const saveChosenForId = (id: string, pids: string[]): void => {
    const map = loadScriptTargetMap()
    map[id] = pids
    saveScriptTargetMap(map)
    try {
      localStorage.setItem(GM_TARGETS_KEY, JSON.stringify(pids))
    } catch {
      /* ignore */
    }
  }

  /** 按脚本记忆把“当前打开的会话”还原为右侧参与列表（顺序即 ID） */
  const seedFromMemory = (id: string, list: GlobalMacroTarget[]): void => {
    const ordered = memOf(id)
      .map((pid) => list.find((t) => t.profileId === pid))
      .filter((t): t is GlobalMacroTarget => !!t)
    activeScriptRef.current = id
    pendingSeedRef.current = null
    setChosen(ordered)
  }

  /** 选中脚本：立即以其记忆填充参与列表；可用列表未就绪则暂存待播种 */
  const selectScript = (id: string | null): void => {
    setSelId(id)
    if (!id) {
      activeScriptRef.current = null
      pendingSeedRef.current = null
      return
    }
    if (avail.length) seedFromMemory(id, avail)
    else pendingSeedRef.current = id
  }

  // 读取当前打开的可用会话（SSH/串口）
  useEffect(() => {
    let mounted = true
    window.api
      .globalMacroTargets()
      .then((list) => {
        if (!mounted) return
        setAvail(list)
        const cur = scripts.find((s) => s.id === (pendingSeedRef.current ?? activeScriptRef.current))
        if (cur) seedFromMemory(cur.id, list)
        else if (scripts.length && list.length) {
          // 打开对话框默认选中第一个脚本，并按该脚本记忆填充
          seedFromMemory(scripts[0].id, list)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 参与列表变化 → 固化到当前脚本的记忆（切换脚本时 activeScriptRef 已同步）
  useEffect(() => {
    const id = activeScriptRef.current
    if (id) saveChosenForId(id, chosen.map((t) => t.profileId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen])

  useEffect(() => {
    try {
      localStorage.setItem(GM_SCRIPTS_KEY, JSON.stringify(scripts))
    } catch {
      /* ignore */
    }
  }, [scripts])

  const selected = scripts.find((s) => s.id === selId) ?? scripts[0] ?? null
  const inChosen = (pid: string): boolean => chosen.some((t) => t.profileId === pid)

  const addAvail = (pid: string): void => {
    const t = avail.find((x) => x.profileId === pid)
    if (!t || inChosen(pid)) return
    setChosen((prev) => [...prev, t])
  }
  const removeChosen = (pid: string): void => {
    setChosen((prev) => prev.filter((t) => t.profileId !== pid))
  }
  const moveChosen = (pid: string, dir: -1 | 1): void => {
    setChosen((prev) => {
      const i = prev.findIndex((t) => t.profileId === pid)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      const [it] = next.splice(i, 1)
      next.splice(j, 0, it)
      return next
    })
  }
  const insertChosenAt = (pid: string, index: number): void => {
    const t = avail.find((x) => x.profileId === pid)
    if (!t) return
    setChosen((prev) => {
      const next = prev.filter((x) => x.profileId !== pid)
      const i = Math.max(0, Math.min(index, next.length))
      next.splice(i, 0, t)
      return next
    })
  }
  const reorderChosen = (fromPid: string, index: number): void => {
    setChosen((prev) => {
      const fi = prev.findIndex((t) => t.profileId === fromPid)
      if (fi < 0) return prev
      const next = prev.filter((t) => t.profileId !== fromPid)
      const i = Math.max(0, Math.min(index, next.length))
      next.splice(i, 0, prev[fi])
      return next
    })
  }

  const patch = (p: Partial<GlobalMacroScript>): void => {
    setScripts((prev) =>
      prev.map((s) => (s.id === selected?.id ? { ...s, ...p } : s))
    )
  }

  const parsed = useMemo(() => {
    if (!selected) return { steps: [] as GlobalMacroStep[], error: '' }
    return parseGlobalMacro(selected.text)
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 删除脚本：同时清掉该脚本专属的连接记忆 */
  const delScript = (): void => {
    if (!selected) return
    const id = selected.id
    const next = scripts.filter((s) => s.id !== id)
    const map = loadScriptTargetMap()
    delete map[id]
    saveScriptTargetMap(map)
    setScripts(next)
    if (activeScriptRef.current === id) {
      if (next.length) selectScript(next[0].id)
      else {
        activeScriptRef.current = null
        pendingSeedRef.current = null
        setSelId(null)
        setChosen([])
      }
    }
  }

  const run = (): void => {
    if (!selected || !chosen.length) return
    const { steps, error } = parseGlobalMacro(selected.text)
    if (error || steps.length === 0) {
      void uiAlert(error || '脚本为空')
      return
    }
    for (const st of steps) {
      if (st.op !== 'sleep' && (st.target < 0 || st.target >= chosen.length)) {
        void uiAlert(`脚本引用了会话 ID ${st.target}，但只选了 ${chosen.length} 个会话（顺序从 0 开始）`)
        return
      }
    }
    // 固化到当前脚本（即使未改动也确保记忆与本次选择一致）
    activeScriptRef.current = selected.id
    saveChosenForId(selected.id, chosen.map((t) => t.profileId))
    onRun(chosen, selected)
  }

  return (
    <div className="dialog-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog global-dialog">
        <div className="dialog-header">
          <h2>联动自动化（多 SSH/串口）</h2>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body global-body">
          {/* 参与会话选择：可用（左）→ 已选（右，顺序=ID） */}
          <div className="gm-pick">
            <div className="gm-col">
              <div className="gm-col-title">当前打开的 SSH / 串口（点击加入）</div>
              <div className="gm-avail">
                {avail.length === 0 && <div className="col-empty">没有已连接的 SSH / 串口会话</div>}
                {avail.map((t) => (
                  <div
                    key={t.profileId}
                    className={`gm-item${inChosen(t.profileId) ? ' picked' : ''}`}
                    draggable
                    onDragStart={() => (dragRef.current = { from: 'avail', profileId: t.profileId })}
                    onDragEnd={() => (dragRef.current = null)}
                    onClick={() => addAvail(t.profileId)}
                    title={`${t.kind === 'serial' ? '串口' : 'SSH'} · 点击加入`}
                  >
                    <span className={`proto-badge ${t.kind}`}>{t.kind === 'serial' ? '串口' : 'SSH'}</span>
                    <span className="gm-name">{t.name}</span>
                    {!inChosen(t.profileId) && <button className="gm-add" onClick={(e) => { e.stopPropagation(); addAvail(t.profileId) }}>＋</button>}
                  </div>
                ))}
              </div>
            </div>

            <div className="gm-col gm-col-right">
              <div className="gm-col-title">自动化会话（顺序即 ID：0,1,2…；可拖动排序；各脚本各自记住，选中即自动带入）</div>
              <div
                className="gm-chosen"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const d = dragRef.current
                  dragRef.current = null
                  if (!d) return
                  if (d.from === 'avail') addAvail(d.profileId)
                  else removeChosen(d.profileId)
                }}
              >
                {chosen.length === 0 && <div className="col-empty">从左侧加入会话</div>}
                {chosen.map((t, i) => (
                  <div
                    key={t.profileId}
                    className="gm-item gm-chosen-item"
                    draggable
                    onDragStart={() => (dragRef.current = { from: 'chosen', profileId: t.profileId })}
                    onDragEnd={() => (dragRef.current = null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const d = dragRef.current
                      if (!d) return
                      e.preventDefault()
                      if (d.from === 'avail') insertChosenAt(d.profileId, i)
                      else reorderChosen(d.profileId, i)
                      dragRef.current = null
                    }}
                  >
                    <span className="gm-idx">{i}</span>
                    <span className={`proto-badge ${t.kind}`}>{t.kind === 'serial' ? '串口' : 'SSH'}</span>
                    <span className="gm-name">{t.name}</span>
                    <span className="gm-ops">
                      <button title="上移" onClick={() => moveChosen(t.profileId, -1)}>↑</button>
                      <button title="下移" onClick={() => moveChosen(t.profileId, 1)}>↓</button>
                      <button className="danger" title="移除" onClick={() => removeChosen(t.profileId)}>×</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 脚本编辑 */}
          <div className="gm-scripts">
            <div className="gm-script-side">
              {scripts.map((s) => (
                <button
                  key={s.id}
                  className={`macro-item${s.id === selected?.id ? ' active' : ''}`}
                  onClick={() => selectScript(s.id)}
                  title={s.name}
                >
                  <span className="macro-name">{s.name}</span>
                </button>
              ))}
              <button
                className="tool-btn macro-new"
                onClick={() => {
                  const s: GlobalMacroScript = { id: uid(), name: '新联动脚本', text: '', loop: 1 }
                  setScripts((prev) => [...prev, s])
                  // 先把它设为“当前脚本”，再清空参与列表，避免清空串写到旧脚本
                  setSelId(s.id)
                  activeScriptRef.current = s.id
                  pendingSeedRef.current = null
                  setChosen([])
                }}
              >
                ＋ 新建
              </button>
              {selected && (
                <button className="tool-btn danger macro-del" onClick={delScript}>
                  删除
                </button>
              )}
            </div>
            {selected && (
              <div className="gm-edit">
                <div className="form-row">
                  {field('名称', <input value={selected.name} onChange={(e) => patch({ name: e.target.value })} />)}
                  {field(
                    '循环',
                    <div className="macro-loop-row">
                      <input
                        type="number"
                        min={1}
                        value={selected.loop === -1 ? '' : selected.loop}
                        disabled={selected.loop === -1}
                        placeholder="次数"
                        onChange={(e) => patch({ loop: Math.max(1, Number(e.target.value) || 1) })}
                      />
                      <label className="checkbox-inline">
                        <input
                          type="checkbox"
                          checked={selected.loop === -1}
                          onChange={(e) => patch({ loop: e.target.checked ? -1 : 1 })}
                        />
                        无限
                      </label>
                    </div>
                  )}
                </div>
                <label className="form-field macro-text">
                  <span className="form-label">命令（每行一条；ID=右侧会话顺序）</span>
                  <textarea
                    value={selected.text}
                    spellCheck={false}
                    onChange={(e) => patch({ text: e.target.value })}
                    placeholder={'TX0 "run test"   向会话0发送\nRX1 "Ready>"    等会话1输出包含\nsleep 10         延时10秒'}
                  />
                </label>
                <div className="macro-hint">
                  <code>TX{'{ID}'}</code> 发送 ｜ <code>RX{'{ID}'}</code> 等待输出包含 ｜
                  <code>sleep</code> 延时（sleep 10 默认 10 秒；可用 sleep 10s / 2m / 1h）。ID 从 0 开始，对应右侧“自动化会话”的顺序。
                </div>
                <div className="macro-parse">
                  {parsed.error ? (
                    <span className="macro-err">{parsed.error}</span>
                  ) : (
                    <span className="macro-ok">
                      已解析 {parsed.steps.length} 步（选择 {chosen.length} 个会话）
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer macro-actions">
          <button className="btn-cancel" onClick={onClose}>
            关闭
          </button>
          <button className="btn-primary" disabled={!selected || !chosen.length || !!parsed.error} onClick={run}>
            ▶ 运行联动
          </button>
        </div>
      </div>
    </div>
  )
}

function field(label: string, control: ReactNode): ReactNode {
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      {control}
    </label>
  )
}
