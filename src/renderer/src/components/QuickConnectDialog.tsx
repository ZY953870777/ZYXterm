import { useEffect, useMemo, useRef, useState } from 'react'
import { ConnectionProfile, ProtocolType } from '@shared/types'
import { PROTOCOLS } from './protocols'

const DEFAULT_ORDER = PROTOCOLS.map((p) => p.key)

/** 读取首页的类别列顺序（localStorage 持久化），使本框的类型顺序与首页左右一致 */
function readHomeColOrder(): ProtocolType[] {
  try {
    const saved: string[] = JSON.parse(localStorage.getItem('zyxterm-col-order') ?? '[]')
    const order: ProtocolType[] = []
    for (const k of saved) {
      const key = k as ProtocolType
      if (DEFAULT_ORDER.includes(key) && !order.includes(key)) order.push(key)
    }
    // 补全缺失协议（保持默认相对顺序追加到末尾）
    for (const k of DEFAULT_ORDER) {
      if (!order.includes(k)) order.push(k)
    }
    return order
  } catch {
    return DEFAULT_ORDER
  }
}

/** 取某个连接的主机/IP，用于搜索 */
function profileHost(p: ConnectionProfile): string {
  if (p.ssh) return p.ssh.host || ''
  if (p.serial) return p.serial.mode === 'tcp' ? p.serial.host || '' : p.serial.path || ''
  if (p.vnc) return p.vnc.host || ''
  if (p.rdp) return p.rdp.host || ''
  return ''
}

interface Props {
  profiles: ConnectionProfile[]
  onClose: () => void
  onOpen: (profile: ConnectionProfile) => void
  onEdit: (profile: ConnectionProfile) => void
  onDelete: (id: string) => void
  onNew: (protocol: ProtocolType) => void
}

/** 标签栏「+」弹出的快速选择框：顶部协议页签 + 搜索 + 单个可滚动列表 */
export default function QuickConnectDialog({
  profiles,
  onClose,
  onOpen,
  onEdit,
  onDelete,
  onNew
}: Props) {
  const order = useMemo(readHomeColOrder, [])
  // active: '__all__' 或某协议；默认全部
  const [active, setActive] = useState<ProtocolType | '__all__'>('__all__')
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // 协议计数（用于页签上的数量提示）
  const counts = useMemo(() => {
    const c: Partial<Record<ProtocolType | '__all__', number>> = { __all__: profiles.length }
    for (const p of profiles) c[p.protocol] = (c[p.protocol] ?? 0) + 1
    return c
  }, [profiles])

  // 过滤：协议 + 关键字（名称/主机）
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    return profiles.filter((p) => {
      if (active !== '__all__' && p.protocol !== active) return false
      if (!q) return true
      const hay = `${p.name} ${profileHost(p)}`.toLowerCase()
      return hay.includes(q)
    })
  }, [profiles, active, q])

  // 可见分组（顺序跟随首页列顺序；无内容且未搜索时仍显示“暂无”，否则隐藏空组）
  const visibleKeys = useMemo(() => {
    if (active === '__all__') return order
    return DEFAULT_ORDER.includes(active) ? [active] : []
  }, [active, order])

  // 调试：记录列表容器实测尺寸（排查滚动问题用，写入 userData/debug.log）
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const t = window.setTimeout(() => {
      try {
        const dialog = el.closest('.dialog')
        window.api.debugLog(
          `quick list items=${shown.length} active=${active} q="${query}" ` +
            `list clientH=${el.clientHeight} scrollH=${el.scrollHeight} ` +
            `dialog clientH=${dialog ? dialog.clientHeight : -1} scrollH=${
              dialog ? dialog.scrollHeight : -1
            } winH=${window.innerHeight}`
        )
      } catch {
        /* ignore */
      }
    }, 100)
    return () => window.clearTimeout(t)
  }, [shown.length, active, query])

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

        {/* 协议页签（顺序跟随首页列顺序）+ 搜索 */}
        <div className="quick-tabs">
          <button
            className={`quick-tab${active === '__all__' ? ' active' : ''}`}
            onClick={() => setActive('__all__')}
          >
            全部 <span className="qt-count">{profiles.length}</span>
          </button>
          {order.map((key) => {
            const meta = PROTOCOLS.find((p) => p.key === key)
            if (!meta) return null
            return (
              <button
                key={key}
                className={`quick-tab${active === key ? ' active' : ''}`}
                onClick={() => setActive(key)}
              >
                {meta.label} <span className="qt-count">{counts[key] ?? 0}</span>
              </button>
            )
          })}
        </div>
        <div className="quick-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / IP / 设备…"
            autoFocus
          />
        </div>

        {/* 单一滚动区：整个弹窗超高时由 .quick-dialog 滚动，底部始终可达 */}
        <div className="dialog-body quick-body-wrap">
          <div ref={listRef} className="quick-body">
            {visibleKeys.length === 0 && <div className="col-empty">无匹配</div>}
            {visibleKeys.map((key) => {
              const meta = PROTOCOLS.find((p) => p.key === key)
              if (!meta) return null
              const list = shown.filter((p) => p.protocol === key)
              if (list.length === 0 && !q && active === '__all__') {
                return (
                  <div key={key} className="quick-group">
                    <div className="quick-group-title">
                      <span className={`proto-badge ${key}`}>{meta.label}</span>
                      <span className="col-desc">{meta.desc}</span>
                    </div>
                    <div className="col-empty">暂无配置</div>
                  </div>
                )
              }
              if (list.length === 0) return null
              return (
                <div key={key} className="quick-group">
                  <div className="quick-group-title">
                    <span className={`proto-badge ${key}`}>{meta.label}</span>
                    <span className="col-desc">{meta.desc}</span>
                    <button
                      className="col-new"
                      title={`新建 ${meta.label}`}
                      onClick={() => {
                        onClose()
                        onNew(key)
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
                      <span className="profile-name">
                        {prof.name}
                        <span className="profile-sub">{profileHost(prof)}</span>
                      </span>
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
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
