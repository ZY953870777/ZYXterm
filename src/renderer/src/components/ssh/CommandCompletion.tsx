interface Props {
  items: string[]
  index: number
  x: number
  y: number
  onSelect: (cmd: string, exec: boolean) => void
}

/** SSH 命令补全下拉：输入时按历史前缀匹配，鼠标点击 / Enter / Tab 选择填入 */
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
