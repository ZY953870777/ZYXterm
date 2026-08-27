import { ConnectionProfile } from '@shared/types'

interface Props {
  profiles: ConnectionProfile[]
  rdpAvailable: boolean
  onOpen: (profile: ConnectionProfile) => void
  onNew: () => void
  onEdit: (profile: ConnectionProfile) => void
  onDelete: (id: string) => void
}

export default function Sidebar({
  profiles,
  rdpAvailable,
  onOpen,
  onNew,
  onEdit,
  onDelete
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">ZYXterm</span>
        <button className="btn-new" onClick={onNew} title="新建连接">
          ＋ 新建
        </button>
      </div>

      {!rdpAvailable && (
        <div className="rdp-warn">
          ⚠ FreeRDP 原生模块未就绪，RDP 嵌入不可用。请确认 freerdp.node
          已随包分发（resources/freerdp/）。
        </div>
      )}

      <div className="sidebar-list">
        {profiles.map((p) => (
          <div
            key={p.id}
            className="profile-item"
            onDoubleClick={() => onOpen(p)}
            title={`${p.name}\n双击连接（${p.protocol.toUpperCase()}）`}
          >
            <span className={`proto-badge ${p.protocol}`}>
              {p.protocol.toUpperCase()}
            </span>
            <span className="profile-name">{p.name}</span>
            <span className="profile-actions">
              <button
                className="icon-btn"
                title="编辑"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(p)
                }}
              >
                ✎
              </button>
              <button
                className="icon-btn"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(p.id)
                }}
              >
                🗑
              </button>
            </span>
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="empty">暂无连接配置，点击「＋ 新建」创建</div>
        )}
      </div>
    </aside>
  )
}
