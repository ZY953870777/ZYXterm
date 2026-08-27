import { ReactNode, useEffect, useState } from 'react'

interface Props {
  children: ReactNode
  /** 是否全屏（由 App 全局状态控制，含轮询校正） */
  fsActive: boolean
  onEnter: () => void
  onExit: () => void
}

/**
 * 会话页面全屏容器（受控组件）
 *
 * - 全屏状态由 App 全局维护（BrowserWindow 真全屏 + 轮询校正），
 *   全屏时由 App 隐藏标题栏/标签栏，本容器自然铺满整个窗口
 * - 鼠标到达页面顶部中央浮出「全屏/退出全屏」操作条
 */
export default function FullscreenView({ children, fsActive, onEnter, onExit }: Props) {
  const [showBar, setShowBar] = useState(false)

  // 全屏状态切换后收起浮条（等鼠标再次到顶部再显示）
  useEffect(() => {
    if (!fsActive) setShowBar(false)
  }, [fsActive])

  return (
    <div
      className="fs-wrap"
      onMouseMove={(e) => {
        // 仅在页面顶部中央区域（水平中间约 30%）显示操作条；移入页面内（且不在
        // 浮条上）→ 隐藏。容器不在视口顶部（下方还有标题栏），须相对容器顶部判断。
        const rect = e.currentTarget.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const inCenter = Math.abs(e.clientX - centerX) <= rect.width * 0.15
        if (inCenter && e.clientY - rect.top <= 12) {
          setShowBar(true)
        } else if (!(e.target as HTMLElement).closest('.fs-bar')) {
          setShowBar(false)
        }
      }}
    >
      {children}
      {/* 顶部透明触发条：onMouseEnter 兜底显示浮条（部分视图 canvas 不冒泡 mousemove） */}
      <div
        className="fs-trigger"
        onMouseEnter={() => setShowBar(true)}
        onMouseLeave={() => setShowBar(false)}
      />
      {showBar && (
        <div
          className="fs-bar"
          onMouseEnter={() => setShowBar(true)}
          onMouseLeave={() => setShowBar(false)}
        >
          <button className="fs-btn" onClick={fsActive ? onExit : onEnter}>
            {fsActive ? '⛶ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      )}
    </div>
  )
}
