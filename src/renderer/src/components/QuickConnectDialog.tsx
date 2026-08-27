import { ConnectionProfile, ProtocolType } from '@shared/types'
import { PROTOCOLS } from './protocols'

interface Props {
  profiles: ConnectionProfile[]
  onClose: () => void
  onOpen: (profile: ConnectionProfile) => void
  onEdit: (profile: ConnectionProfile) => void
  onDelete: (id: string) => void
  onNew: (protocol: ProtocolType) => void
}

/** 标签栏「+」弹出的快速选择框：按类别依次列出配置 */
export default function QuickConnectDialog({
  profiles,
  onClose,
  onOpen,
  onEdit,
  onDelete,
  onNew
}: Props) {
  return (
    <div
      className="dialog-mask"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog quick-dialog">
        <div className="dialog-header">
          <h2>选择连接</h2>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body quick-body">
          {PROTOCOLS.map((meta) => {
            const list = profiles.filter((p) => p.protocol === meta.key)
            return (
              <div key={meta.key} className="quick-group">
                <div className="quick-group-title">
                  <span className={`proto-badge ${meta.key}`}>{meta.label}</span>
                  <span className="col-desc">{meta.desc}</span>
                  <button
                    className="col-new"
                    title={`新建 ${meta.label}`}
                    onClick={() => {
                      onClose()
                      onNew(meta.key)
                    }}
                  >
                    ＋ 新建
                  </button>
                </div>
                {list.map((prof) => (
                  <div
                    key={prof.id}
                    className="profile-item"
                    onDoubleClick={() => {
                      onOpen(prof)
                      onClose()
                    }}
                    title={`${prof.name} · 双击连接`}
                  >
                    <span className="profile-name">{prof.name}</span>
                    <span className="profile-actions">
                      <button
                        className="icon-btn"
                        title="编辑"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(prof)
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(prof.id)
                        }}
                      >
                        🗑
                      </button>
                    </span>
                  </div>
                ))}
                {list.length === 0 && (
                  <div className="col-empty">暂无配置</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
