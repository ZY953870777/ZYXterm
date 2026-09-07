interface Props {
  items: string[]
  /** 当前选中项下标；-1 表示没有任何选中项（下拉打开时默认状态） */
  index: number
  x: number
  y: number
  onSelect: (cmd: string, exec: boolean) => void
}

/**
 * SSH 命令补全下拉：输入时按历史前缀匹配，鼠标点击 / 上下键选中后回车填入。
 * 下拉出现时不预选任何条目，避免直接回车把第一条误填入输入框。
 */
export default function CommandCompletion({ items, index, x, y, onSelect }: Props) {
  if (items.length === 0) return null
  return (
    <div className="cmd-completion" style={{ left: x, top: y }}>
      {items.map((it, i) => (
        <div
          key={`${i}-${it}`}
          className={`cmd-completion-item ${i === index ? 'selected' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(it, false)}
          title={`填入「${it}」`}
        >
          {it}
        </div>
      ))}
    </div>
  )
}
