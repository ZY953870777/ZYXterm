import { useRef, useState } from 'react'
import { ConnectionProfile, ProtocolType } from '@shared/types'
import { PROTOCOLS } from './protocols'

interface Props {
  profiles: ConnectionProfile[]
  rdpAvailable: boolean
  onOpen: (profile: ConnectionProfile) => void
  onNew: (protocol: ProtocolType) => void
  onEdit: (profile: ConnectionProfile) => void
  onDelete: (id: string) => void
  /** 同协议类别内把 fromId 移到 toId 位置（持久化） */
  onReorder: (protocol: ProtocolType, fromId: string, toId: string) => void
}

const DEFAULT_ORDER = PROTOCOLS.map((p) => p.key)

/** 首页：按协议类别分列显示连接配置；类别列可拖动互换顺序，类别内可拖动排序 */
export default function ConnectionGrid({
  profiles,
  rdpAvailable,
  onOpen,
  onNew,
  onEdit,
  onDelete,
  onReorder
}: Props) {
  // 类别（列）顺序：本地持久化（纯 UI 偏好），无效值回退默认
  const [colOrder, setColOrder] = useState<ProtocolType[]>(() => {
    try {
      const saved: string[] = JSON.parse(
        localStorage.getItem('zyxterm-col-order') ?? '[]'
      )
      const order: ProtocolType[] = []
      // 保留用户保存的相对顺序（只取有效协议、去重），否则拖拽后的顺序
      // 会被按默认顺序重排，导致重启后不记住拖拽结果
      for (const k of saved) {
        const key = k as ProtocolType
        if (DEFAULT_ORDER.includes(key) && !order.includes(key)) order.push(key)
      }
      // 补全缺失的协议（新加入的协议追加到末尾）
      for (const k of DEFAULT_ORDER) {
        if (!order.includes(k)) order.push(k)
      }
      return order
    } catch {
      return DEFAULT_ORDER
    }
  })
  const saveColOrder = (order: ProtocolType[]): void => {
    setColOrder(order)
    localStorage.setItem('zyxterm-col-order', JSON.stringify(order))
  }

  // 列拖拽状态
  const dragColRef = useRef<ProtocolType | null>(null)
  const [dropCol, setDropCol] = useState<ProtocolType | null>(null)
  // 内容拖拽状态（限制在同类内）
  const dragItemRef = useRef<{ protocol: ProtocolType; id: string } | null>(null)
  const [dropItemId, setDropItemId] = useState<string | null>(null)

  return (
    <div className="grid-view">
      <div className="grid-header">
        <h1>ZYXterm</h1>
        <p>双击连接配置打开 · 点击列标题「＋」新建该类连接 · 拖动列标题/连接可排序</p>
      </div>

      <div className="grid-cols">
        {colOrder.map((key) => {
          const meta = PROTOCOLS.find((p) => p.key === key)
          if (!meta) return null
          const list = profiles.filter((p) => p.protocol === key)
          return (
            <div
              key={key}
              className={`grid-col ${dropCol === key ? 'drop-target' : ''}`}
            >
              <div
                className="col-header"
                draggable
                title="拖动可调整类别顺序"
                onDragStart={(e) => {
                  dragColRef.current = key
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  dragColRef.current = null
                  setDropCol(null)
                }}
                onDragOver={(e) => {
                  if (dragColRef.current && dragColRef.current !== key) {
                    e.preventDefault()
                    setDropCol(key)
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = dragColRef.current
                  dragColRef.current = null
                  setDropCol(null)
                  if (!from || from === key) return
                  const order = [...colOrder]
                  order.splice(order.indexOf(from), 1)
                  order.splice(order.indexOf(key), 0, from)
                  saveColOrder(order)
                }}
              >
                <span className={`proto-badge ${key}`}>{meta.label}</span>
                <span className="col-desc">{meta.desc}</span>
                <span className="col-count">{list.length}</span>
                <button
                  className="col-new"
                  title={`新建 ${meta.label}`}
                  draggable={false}
                  onClick={() => onNew(key)}
                >
                  ＋
                </button>
              </div>
              <div className="col-list">
                {list.map((prof) => (
                  <div
                    key={prof.id}
                    className={`profile-item ${
                      dragItemRef.current?.id === prof.id ? 'dragging' : ''
                    } ${dropItemId === prof.id ? 'drop-target' : ''}`}
                    draggable
                    title={`${prof.name} · 双击连接 · 拖动排序`}
                    onDragStart={(e) => {
                      dragItemRef.current = { protocol: key, id: prof.id }
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => {
                      dragItemRef.current = null
                      setDropItemId(null)
                    }}
                    onDragOver={(e) => {
                      const d = dragItemRef.current
                      if (d && d.protocol === key && d.id !== prof.id) {
                        e.preventDefault()
                        setDropItemId(prof.id)
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const d = dragItemRef.current
                      setDropItemId(null)
                      dragItemRef.current = null
                      if (d && d.protocol === key && d.id !== prof.id) {
                        onReorder(key, d.id, prof.id)
                      }
                    }}
                    onDoubleClick={() => onOpen(prof)}
                  >
                    <span className="profile-name">{prof.name}</span>
                    <span className="profile-actions">
                      <button
                        className="icon-btn"
                        title="编辑"
                        draggable={false}
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
                        draggable={false}
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
                {list.length === 0 && <div className="col-empty">暂无配置</div>}
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
