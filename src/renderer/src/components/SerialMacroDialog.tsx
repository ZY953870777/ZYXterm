import { ReactNode, useEffect, useMemo, useState } from 'react'
import { SerialMacroScript } from '@shared/types'
import { parseMacroScript } from '../macroParser'

const MACRO_KEY = 'zyxterm:serial-macros'

const SAMPLE = `# 串口自动化示例：等待提示符后发送命令
tx "\\n"
rx "login:"
tx "root\\n"
sleep 1s
tx "ls -l\\n"`

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function loadScripts(): SerialMacroScript[] {
  try {
    const raw = localStorage.getItem(MACRO_KEY)
    if (raw) {
      const arr = JSON.parse(raw) as SerialMacroScript[]
      if (Array.isArray(arr)) return arr.filter((s) => s && typeof s.id === 'string')
    }
  } catch {
    /* ignore */
  }
  return [{ id: uid(), name: '示例脚本', text: SAMPLE, loop: 1 }]
}

interface Props {
  onRun: (script: SerialMacroScript) => void
  onClose: () => void
}

/** 串口自动化脚本编辑器：新建/保存 TX-RX-SLEEP 脚本，点「运行」交给会话执行 */
export default function SerialMacroDialog({ onRun, onClose }: Props) {
  const [scripts, setScripts] = useState<SerialMacroScript[]>(loadScripts)
  const [selId, setSelId] = useState<string | null>(null)

  const selected = scripts.find((s) => s.id === selId) ?? scripts[0] ?? null

  useEffect(() => {
    try {
      localStorage.setItem(MACRO_KEY, JSON.stringify(scripts))
    } catch {
      /* ignore */
    }
  }, [scripts])

  const patch = (p: Partial<SerialMacroScript>): void => {
    setScripts((prev) =>
      prev.map((s) => (s.id === selected?.id ? { ...s, ...p } : s))
    )
  }

  const parsed = useMemo(() => {
    if (!selected) return { steps: [] as ReturnType<typeof parseMacroScript>['steps'], error: '' }
    return parseMacroScript(selected.text)
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const onNew = (): void => {
    const s: SerialMacroScript = { id: uid(), name: '新脚本', text: '', loop: 1 }
    setScripts((prev) => [...prev, s])
    setSelId(s.id)
  }

  const onDelete = (): void => {
    if (!selected) return
    setScripts((prev) => {
      const next = prev.filter((s) => s.id !== selected.id)
      if (selId === selected.id) setSelId(next[0]?.id ?? null)
      return next
    })
  }

  const loopLabel = (n: number): string => (n === -1 ? '无限' : `${n} 次`)

  return (
    <div className="dialog-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog macro-dialog">
        <div className="dialog-header">
          <h2>串口自动化脚本</h2>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body macro-body">
          {/* 脚本列表 + 操作 */}
          <div className="macro-side">
            {scripts.map((s) => (
              <button
                key={s.id}
                className={`macro-item${s.id === selected?.id ? ' active' : ''}`}
                onClick={() => setSelId(s.id)}
                title={s.name}
              >
                <span className="macro-name">{s.name}</span>
                <span className="macro-loop">{loopLabel(s.loop)}</span>
              </button>
            ))}
            <button className="tool-btn macro-new" onClick={onNew}>
              ＋ 新建
            </button>
            {selected && (
              <button className="tool-btn danger macro-del" onClick={onDelete}>
                删除
              </button>
            )}
          </div>

          {/* 编辑区 */}
          {selected && (
            <div className="macro-edit">
              <div className="form-row">
                {field('名称', <input value={selected.name} onChange={(e) => patch({ name: e.target.value })} />)}
                {field(
                  '循环（次数）',
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
                <span className="form-label">命令（每行一条，大小写不敏感）</span>
                <textarea
                  value={selected.text}
                  spellCheck={false}
                  onChange={(e) => patch({ text: e.target.value })}
                  placeholder={'tx "hello\\n"  发送\nrx "login:"   等待输出包含\nsleep 5s      延时'}
                />
              </label>
              <div className="macro-hint">
                <code>tx</code> 发送内容（支持 \n \r \t）｜<code>rx</code> 等待输出包含｜
                <code>sleep</code> 延时：sleep 10 默认 10 秒；可用 sleep 10s / 2m / 1h。引号可省、可单可双，行首 <code>#</code> 为注释。
              </div>
              <div className="macro-parse">
                {parsed.error ? (
                  <span className="macro-err">{parsed.error}</span>
                ) : (
                  <span className="macro-ok">
                    已解析 {parsed.steps.length} 步；运行后将弹出进度页实时显示。
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="dialog-footer macro-actions">
          <button className="btn-cancel" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn-primary"
            disabled={!selected || !!parsed.error}
            onClick={() => selected && onRun(selected)}
          >
            ▶ 运行
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
