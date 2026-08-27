interface Props {
  history: string[]
  onJump: (cmd: string) => void
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
            key={`${i}-${h}`}
            className="cmd-history-item"
            onClick={() => onJump(h)}
            onDoubleClick={() => onRun(h)}
            title={`单击跳转 / 双击执行「${h}」`}
          >
            {h}
          </div>
        ))}
        {history.length === 0 && <div className="cmd-empty">暂无命令</div>}
      </div>
    </div>
  )
}
