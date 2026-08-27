import { ConnectionProfile, ProtocolType } from '@shared/types'
import { PROTOCOLS } from './protocols'

interface Props {
  profiles: ConnectionProfile[]
  rdpAvailable: boolean
  onOpen: (profile: ConnectionProfile) => void
  onNew: (protocol: ProtocolType) => void
  onEdit: (profile: ConnectionProfile) => void
  onDelete: (id: string) => void
}

/** 首页：按协议类别分列显示连接配置 */
export default function ConnectionGrid({
  profiles,
  rdpAvailable,
  onOpen,
  onNew,
  onEdit,
  onDelete
}: Props) {
  return (
    <div className="grid-view">
      <div className="grid-header">
        <h1>ZYXterm</h1>
        <p>双击连接配置打开 · 点击列标题「＋」新建该类连接</p>
      </div>

      <div className="grid-cols">
        {PROTOCOLS.map((meta) => {
          const list = profiles.filter((p) => p.protocol === meta.key)
          return (
            <div key={meta.key} className="grid-col">
              <div className="col-header">
                <span className={`proto-badge ${meta.key}`}>{meta.label}</span>
                <span className="col-desc">{meta.desc}</span>
                <span className="col-count">{list.length}</span>
                <button
                  className="col-new"
                  title={`新建 ${meta.label}`}
                  onClick={() => onNew(meta.key)}
                >
                  ＋
                </button>
              </div>
              <div className="col-list">
                {list.map((prof) => (
                  <div
                    key={prof.id}
                    className="profile-item"
                    onDoubleClick={() => onOpen(prof)}
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
            </div>
          )
        })}
      </div>

      {!rdpAvailable && (
        <div className="rdp-warn">
          ⚠ FreeRDP 原生模块未就绪，RDP 嵌入不可用。请确认 freerdp.node
          已随包分发（resources/freerdp/）。
        </div>
      )}
    </div>
  )
}
