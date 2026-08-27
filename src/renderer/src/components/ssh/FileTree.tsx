import { useState } from 'react'
import { SshDirEntry } from '@shared/types'

interface Props {
  cwd: string | null
  entries: SshDirEntry[]
  onCd: (name: string) => void
  onGoUp: () => void
  onRefresh: () => void
  onManualCd: (path: string) => void
  onDownload: (entry: SshDirEntry) => void
  onUploadDrop: (file: File) => void
  /** 外部控制面板宽度（可拖动分隔线调节） */
  style?: React.CSSProperties
}

/**
 * SSH 文件树（左侧）：
 * - 显示当前目录内容，进入/返回/刷新/手动输入路径（仅浏览，不改变 SSH 目录）
 * - 文件双击下载到本地；拖拽本地文件到此处上传
 */
export default function FileTree({
  cwd,
  entries,
  onCd,
  onGoUp,
  onRefresh,
  onManualCd,
  onDownload,
  onUploadDrop,
  style
}: Props) {
  const [manual, setManual] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const dirs = entries.filter((e) => e.type === 'dir')
  const files = entries.filter((e) => e.type !== 'dir')

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) onUploadDrop(file)
  }

  return (
    <div
      className={`file-tree ${dragOver ? 'drop-over' : ''}`}
      style={style}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="panel-title">文件{dragOver ? ' · 拖放以上传' : ''}</div>
      <div className="file-tree-cwd">
        <input
          value={manual || cwd || ''}
          placeholder="目录路径，回车切换"
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && manual.trim()) {
              onManualCd(manual.trim())
              setManual('')
            }
          }}
        />
        <button className="icon-btn" title="刷新" onClick={onRefresh}>
          ⟳
        </button>
        <button className="icon-btn" title="上级目录" onClick={onGoUp}>
          ↑
        </button>
      </div>
      <div className="file-tree-list">
        <div className="file-item dir" onClick={onGoUp} title="上级目录">
          <span className="file-ico">📂</span> ..
        </div>
        {dirs.map((d) => (
          <div
            key={d.name}
            className="file-item dir"
            onClick={() => onCd(d.name)}
            title={`${d.name}/ · ${d.mtime}`}
          >
            <span className="file-ico">📂</span> {d.name}
          </div>
        ))}
        {files.map((f) => (
          <div
            key={f.name}
            className="file-item file"
            title={`${f.name} · ${f.size} B · 双击下载`}
            onDoubleClick={() => onDownload(f)}
          >
            <span className="file-ico">📄</span> {f.name}
          </div>
        ))}
        {entries.length === 0 && <div className="file-empty">（空目录 / 读取中…）</div>}
      </div>
    </div>
  )
}
