import { useRef, useState } from 'react'
import { Tab } from '../App'
import { PROTOCOLS } from './protocols'

interface Props {
  tabs: Tab[]
  activeId: string | null
  /** 是否处于首页（固定 tab，不可拖拽/关闭） */
  activeIsHome: boolean
  onSelect: (id: string) => void
  onSelectHome: () => void
  onClose: (id: string) => void
  onAdd: () => void
  onReconnect: (tab: Tab) => void
  onEdit: (tab: Tab) => void
  onReorder: (from: number, to: number) => void
  onDetachTab: (tab: Tab) => void
  onAttachTab: (tab: Tab, targetWindowId: number) => void
}

const STATUS_TEXT: Record<string, string> = {
  connecting: '正在连接…',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接错误'
}

interface MenuState {
  x: number
  y: number
  tab: Tab
}

interface TipState {
  x: number
  y: number
  tab: Tab
}

interface GhostState {
  x: number
  y: number
  label: string
  name: string
}

interface DragState {
  idx: number
  startX: number
  startY: number
  mode: 'none' | 'h' | 'v'
  overIdx: number
}

export default function SessionTabs({
  tabs,
  activeId,
  activeIsHome,
  onSelect,
  onSelectHome,
  onClose,
  onAdd,
  onReconnect,
  onEdit,
  onReorder,
  onDetachTab,
  onAttachTab
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const closeMenu = (): void => setMenu(null)

  // 悬停 tab 显示连接状态（fixed 定位，避免被 .tabs 的 overflow 裁剪）
  const showTip = (e: React.MouseEvent<HTMLDivElement>, tab: Tab): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ x: r.left + r.width / 2, y: r.top, tab })
  }

  /** 依据鼠标横向位置计算插入目标 index（仅会话 tab，排除固定首页） */
  const computeHoverIndex = (clientX: number): number => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('.tabs .tab:not(.tab-home)')
    )
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return i
    }
    return els.length - 1
  }

  const onPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    idx: number
  ): void => {
    if (e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore：合成事件下可能不支持捕获 */
    }
    dragRef.current = {
      idx,
      startX: e.clientX,
      startY: e.clientY,
      mode: 'none',
      overIdx: idx
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (d.mode === 'none') {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        d.mode = 'h'
      } else if (dy > 60) {
        d.mode = 'v'
      }
    }
    if (d.mode === 'h') {
      const over = computeHoverIndex(e.clientX)
      if (over !== d.overIdx) {
        d.overIdx = over
        setHoverIdx(over)
      }
    } else if (d.mode === 'v') {
      const tab = tabs[d.idx]
      const label = PROTOCOLS.find((p) => p.key === tab.protocol)?.label ?? tab.protocol
      setGhost({ x: e.clientX, y: e.clientY, label, name: tab.name })
    }
  }

  const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>): Promise<void> => {
    const d = dragRef.current
    dragRef.current = null
    setGhost(null)
    setHoverIdx(null)
    if (!d) return
    if (d.mode === 'h') {
      if (d.overIdx !== d.idx) onReorder(d.idx, d.overIdx)
      return
    }
    if (d.mode === 'v') {
      const tab = tabs[d.idx]
      if (!tab) return
      try {
        const res = await window.api.dropTab()
        if (res.action === 'attach' && res.targetWindowId != null) {
          await onAttachTab(tab, res.targetWindowId)
        } else if (res.action === 'detach') {
          await onDetachTab(tab)
        }
        // action === 'none'：鼠标仍在本窗口，取消分离
      } catch (err) {
        console.error('tab drop 失败:', err)
      }
    }
  }

  return (
    <div className="tabs">
      {/* 固定首页 tab：不可拖拽、不可关闭 */}
      <div
        className={`tab tab-home ${activeIsHome ? 'active' : ''}`}
        onClick={onSelectHome}
        title="首页"
      >
        <span className="proto-badge home">⌂</span>
      </div>
      {tabs.map((t, i) => {
        const statusText = STATUS_TEXT[t.status] ?? t.status
        const protoLabel = PROTOCOLS.find((p) => p.key === t.protocol)?.label ?? t.protocol
        const dragging = dragRef.current?.mode === 'h' && dragRef.current.idx === i
        const isDropTarget = hoverIdx === i && dragRef.current?.mode === 'h'
        return (
          <div
            key={t.sessionId}
            className={`tab ${t.sessionId === activeId ? 'active' : ''} ${t.status} ${
              dragging ? 'dragging' : ''
            } ${isDropTarget ? 'drop-target' : ''}`}
            onPointerDown={(e) => onPointerDown(e, i)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => void onPointerUp(e)}
            onClick={() => onSelect(t.sessionId)}
            onMouseEnter={(e) => showTip(e, t)}
            onMouseLeave={() => setTip(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ x: e.clientX, y: e.clientY, tab: t })
            }}
          >
            <span className={`proto-badge ${t.protocol}`}>{protoLabel}</span>
            <span className="tab-title">{t.name}</span>
            <button
              className="tab-close"
              title="关闭"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onClose(t.sessionId)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button className="tab-add" onClick={onAdd} title="新建 / 选择连接">
        ＋
      </button>

      {menu && (
        <>
          <div
            className="tab-menu-mask"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault()
              closeMenu()
            }}
          />
          <div className="tab-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                onReconnect(menu.tab)
                closeMenu()
              }}
            >
              重新连接
            </button>
            <button
              onClick={() => {
                onEdit(menu.tab)
                closeMenu()
              }}
            >
              编辑
            </button>
            <button
              className="danger"
              onClick={() => {
                onClose(menu.tab.sessionId)
                closeMenu()
              }}
            >
              关闭
            </button>
          </div>
        </>
      )}

      {/* 悬停 tab 时的状态 tooltip */}
      {tip && (
        <div
          className="tab-tooltip"
          style={{ left: tip.x, top: tip.y - 8 }}
          data-status={tip.tab.status}
        >
          <div className="tab-tooltip-name">{tip.tab.name}</div>
          <div className="tab-tooltip-status">
            {STATUS_TEXT[tip.tab.status] ?? tip.tab.status}
          </div>
          {tip.tab.message && <div className="tab-tooltip-msg">{tip.tab.message}</div>}
        </div>
      )}

      {/* 向下拖拽时的幽灵 tab（跟随鼠标） */}
      {ghost && (
        <div className="tab-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className={`proto-badge ${tabs[dragRef.current?.idx ?? 0]?.protocol}`}>
            {ghost.label}
          </span>
          <span className="tab-title">{ghost.name}</span>
        </div>
      )}
    </div>
  )
}
