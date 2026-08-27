import { useState } from 'react'

export interface QuickCommand {
  /** 命令显示名（可选，不填则显示命令本身） */
  name?: string
  cmd: string
}

export interface QuickCommandGroup {
  id: string
  name: string
  commands: QuickCommand[]
}

interface Props {
  groups: QuickCommandGroup[]
  onRun: (cmd: string) => void
  onUpdate: (groups: QuickCommandGroup[]) => void
}

/**
 * SSH 底部快捷命令栏：平铺显示所有类别
 * 「✎ 编辑 | 类别1名 命令1 命令2 … | 类别2名 命令1 命令2 …」
 * 点击「✎ 编辑」打开弹窗管理类别与命令（命令可命名）
 */
export default function QuickCommandBar({ groups, onRun, onUpdate }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<QuickCommandGroup[]>([])

  const openEdit = (): void => {
    setDraft(
      groups.map((g) => ({ ...g, commands: g.commands.map((c) => ({ ...c })) }))
    )
    setEditing(true)
  }

  const saveEdit = (): void => {
    onUpdate(draft)
    setEditing(false)
  }

  const setDraftAt = (
    gi: number,
    fn: (g: QuickCommandGroup) => QuickCommandGroup
  ): void => setDraft((d) => d.map((g, i) => (i === gi ? fn(g) : g)))

  return (
    <div className="quick-bar">
      <button className="quick-edit-btn" title="编辑快捷命令" onClick={openEdit}>
        ✎ 编辑
      </button>
      {groups.map((g) => (
        <div key={g.id} className="quick-group-block">
          <span className="quick-group-name">{g.name}</span>
          {g.commands.map((c) => (
            <button
              key={c.cmd + '|' + (c.name ?? '')}
              className="quick-cmd-btn"
              title={c.cmd}
              onClick={() => onRun(c.cmd)}
            >
              {c.name || c.cmd}
            </button>
          ))}
        </div>
      ))}
      {groups.length === 0 && <span className="quick-empty">（无快捷命令，点「✎ 编辑」添加）</span>}

      {editing && (
        <div
          className="dialog-mask"
          onMouseDown={(e) => e.target === e.currentTarget && setEditing(false)}
        >
          <div className="dialog quick-edit-dialog">
            <div className="dialog-header">
              <h2>编辑快捷命令</h2>
              <button className="dialog-close" onClick={() => setEditing(false)}>
                ×
              </button>
            </div>
            <div className="dialog-body">
              {draft.map((g, gi) => (
                <div key={g.id} className="qe-group">
                  <div className="qe-group-head">
                    <input
                      className="qe-name"
                      value={g.name}
                      onChange={(e) =>
                        setDraftAt(gi, (x) => ({ ...x, name: e.target.value }))
                      }
                    />
                    <button
                      className="danger"
                      onClick={() =>
                        setDraft((d) => d.filter((_, i) => i !== gi))
                      }
                    >
                      删除类别
                    </button>
                  </div>
                  {g.commands.map((c, ci) => (
                    <div key={ci} className="qe-cmd">
                      <input
                        placeholder="名称（可选，显示时优先用名称）"
                        value={c.name ?? ''}
                        onChange={(e) =>
                          setDraftAt(gi, (x) => ({
                            ...x,
                            commands: x.commands.map((y, j) =>
                              j === ci ? { ...y, name: e.target.value } : y
                            )
                          }))
                        }
                      />
                      <input
                        placeholder="命令"
                        value={c.cmd}
                        onChange={(e) =>
                          setDraftAt(gi, (x) => ({
                            ...x,
                            commands: x.commands.map((y, j) =>
                              j === ci ? { ...y, cmd: e.target.value } : y
                            )
                          }))
                        }
                      />
                      <button
                        className="danger"
                        title="删除命令"
                        onClick={() =>
                          setDraftAt(gi, (x) => ({
                            ...x,
                            commands: x.commands.filter((_, j) => j !== ci)
                          }))
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    className="qe-add-cmd"
                    onClick={() =>
                      setDraftAt(gi, (x) => ({
                        ...x,
                        commands: [...x.commands, { cmd: '' }]
                      }))
                    }
                  >
                    ＋ 命令
                  </button>
                </div>
              ))}
              <button
                className="qe-add-group"
                onClick={() =>
                  setDraft((d) => [
                    ...d,
                    { id: 'g-' + Date.now() + Math.random(), name: '新类别', commands: [] }
                  ])
                }
              >
                ＋ 类别
              </button>
            </div>
            <div className="dialog-footer">
              <button className="primary" onClick={saveEdit}>
                保存
              </button>
              <button onClick={() => setEditing(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
