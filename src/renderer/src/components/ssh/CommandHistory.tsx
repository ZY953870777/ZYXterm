/** 历史条目：cmd 命令文本；tail 执行时输入行距缓冲区底部的行距（跳转锚点） */
export interface HistEntry {
  cmd: string
  tail: number
}

interface Props {
  history: HistEntry[]
  onJump: (entry: HistEntry) => void
  onRun: (cmd: string) => void
  /** 外部控制面板宽度（可拖动分隔线调节） */
  style?: React.CSSProperties
}

/** SSH 命令历史（右侧）：单击跳转到终端对应位置，双击重新执行 */
export default function CommandHistory({ history, onJump, onRun, style }: Props) {
  return (
    <div className="cmd-history" style={style}>
      <div className="panel-title">历史（单击跳转 / 双击执行）</div>
      <div className="cmd-history-list">
        {history.map((h, i) => (
          <div
            key={`${i}-${h.cmd}`}
            className="cmd-history-item"
            onClick={() => onJump(h)}
            onDoubleClick={() => onRun(h.cmd)}
            title={`单击跳转 / 双击执行「${h.cmd}」`}
          >
            {h.cmd}
          </div>
        ))}
        {history.length === 0 && <div className="cmd-empty">暂无命令</div>}
      </div>
    </div>
  )
}
