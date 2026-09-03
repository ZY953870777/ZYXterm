import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { VNCScaleMode } from '@shared/types'
import { Tab } from '../App'

interface Props {
  tab: Tab
}

/**
 * VNC 视图
 * 通过 @novnc/novnc 的 RFB 客户端连接主进程的 WebSocket 代理。
 *
 * 注意：
 * - RFB 的 target 必须是 <div> 容器（novnc 会在其内部创建 canvas）。
 * - 缩放手动控制 canvas 尺寸，支持模式：
 *   none 原始尺寸 / fit 等比适配 / fill 拉伸铺满 / cover 等比铺满裁剪
 */
export default function VNCView({ tab }: Props) {
  const screenRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const securityErrRef = useRef('')
  const [endpoint, setEndpoint] = useState<string | null>(tab.wsEndpoint ?? null)
  const [msg, setMsg] = useState('连接中…')

  // tab 上已有的端点（来自 status 事件）同步到本地
  useEffect(() => {
    if (tab.wsEndpoint) setEndpoint(tab.wsEndpoint)
  }, [tab.wsEndpoint])

  // 会话状态错误时显示错误信息
  useEffect(() => {
    if (tab.status === 'error') {
      setMsg(tab.message ?? '连接错误')
    } else if (tab.status === 'disconnected') {
      setMsg(securityErrRef.current || '已断开')
    }
  }, [tab.status, tab.message])

  // 主动轮询 WebSocket 端点（等待主进程代理就绪）
  useEffect(() => {
    if (endpoint) return
    const timer = setInterval(async () => {
      try {
        const ep = await window.api.getWsEndpoint(tab.sessionId)
        if (ep) {
          setEndpoint(ep)
          clearInterval(timer)
        }
      } catch {
        /* ignore */
      }
    }, 400)
    return () => clearInterval(timer)
  }, [endpoint, tab.sessionId])

  // 端点就绪后建立 RFB 连接
  useEffect(() => {
    if (!endpoint) {
      setMsg('等待 VNC 代理就绪…')
      return
    }
    const screen = screenRef.current
    if (!screen) return

    const cfg = tab.profile.vnc!
    const rfb = new RFB(screen, endpoint, {
      credentials: cfg.password ? { password: cfg.password } : {},
      shared: true,
      viewOnly: cfg.viewOnly,
      // 画质：JPEG 质量（0-9，9 最高）。仅在服务器使用 Tight 编码并支持 JPEG 时生效；
      // 若服务器只支持 Hextile/Raw/ZRLE 等编码，画质设置无效（VNC 协议限制）
      qualityLevel: cfg.quality ?? 6,
      // 压缩级别单独固定为 novnc 默认 2（与画质无关，避免过高压缩导致画面发糊）
      compressionLevel: 2
    })
    rfbRef.current = rfb

    // 缩放方式
    const scaleMode: VNCScaleMode = cfg.scaleMode ?? (cfg.scaleView ? 'fit' : 'none')

    // 当前实际缩放比例，供鼠标坐标换算使用
    const scaleRef = { x: 1, y: 1 }

    // novnc 的 display.scale 是单值，无法表达 fill 的非等比拉伸。
    // scaleViewport=false 时 display.scale 固定为 1.0，鼠标坐标（基于 canvas
    // 视觉尺寸）会原样发给服务器导致错位。这里 patch absX/absY，
    // 让视觉坐标除以实际缩放比例，换算回服务器分辨率。
    interface VncDisplay {
      absX?: (x: number) => number
      absY?: (y: number) => number
    }
    const display = (rfb as unknown as { _display?: VncDisplay })._display
    // 注意：原方法必须 bind(display)，否则调用时 this 为 undefined，
    // novnc 的 absX/absY 内部读取 this._scale 会抛异常导致鼠标事件无法发送
    const rawAbsX = display?.absX
    const rawAbsY = display?.absY
    const origAbsX = rawAbsX?.bind(display)
    const origAbsY = rawAbsY?.bind(display)
    if (display && origAbsX && origAbsY) {
      display.absX = (x: number) => origAbsX(x / scaleRef.x)
      display.absY = (y: number) => origAbsY(y / scaleRef.y)
    }

    // 手动控制画面缩放（none/fit/fill，居中）。
    // 注意：novnc 内部会监听 canvas 父容器尺寸变化（ResizeObserver），
    // 在容器 resize 时把 canvas.style.width/height 重置为原始分辨率，
    // 覆盖直接设置尺寸的方式。因此改用 CSS transform: scale() 缩放，
    // 不受 novnc 重置 width/height 的影响。
    const applyScale = (): void => {
      const canvas = screen.querySelector('canvas')
      const wrap = screen.parentElement
      if (!canvas || !wrap) return
      const cw = wrap.clientWidth
      const ch = wrap.clientHeight
      const iw = canvas.width
      const ih = canvas.height
      if (!cw || !ch || !iw || !ih) return

      let scaleX: number
      let scaleY: number
      switch (scaleMode) {
        case 'none':
          scaleX = 1
          scaleY = 1
          break
        case 'fill':
          scaleX = cw / iw
          scaleY = ch / ih
          break
        case 'fit':
        default: {
          const s = Math.min(cw / iw, ch / ih)
          scaleX = s
          scaleY = s
          break
        }
      }
      const visualW = iw * scaleX
      const visualH = ih * scaleY
      scaleRef.x = scaleX
      scaleRef.y = scaleY
      canvas.style.position = 'absolute'
      canvas.style.transformOrigin = 'left top'
      canvas.style.transform =
        scaleX === 1 && scaleY === 1 ? 'none' : `scale(${scaleX}, ${scaleY})`
      canvas.style.left = `${(cw - visualW) / 2}px`
      canvas.style.top = `${(ch - visualH) / 2}px`
    }

    const wrapEl = screen.parentElement
    const ro = new ResizeObserver(() => applyScale())
    if (wrapEl) ro.observe(wrapEl)
    // 窗口尺寸变化（拖动/最大化到不同屏幕）时重新缩放。
    // resize 事件触发时布局可能尚未更新（clientWidth 为中间值），
    // 用 requestAnimationFrame 延迟到下一帧、布局稳定后再应用，并合并连续事件。
    let rafId = 0
    const onWinResize = (): void => {
      window.cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        // 二次 rAF：win.setSize 触发的 resize 事件中，首帧 wrap 可能仍是中间态，
        // 等到下一帧浏览器完成新布局后再读取容器尺寸并缩放
        rafId = window.requestAnimationFrame(() => applyScale())
      })
    }
    window.addEventListener('resize', onWinResize)

    let connected = false
    const timeout = window.setTimeout(() => {
      if (!connected) setMsg('连接超时，请检查 VNC 服务器地址与端口')
    }, 15000)

    const showSize = (): void => {
      const canvas = screen.querySelector('canvas')
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        setMsg(`已连接 (桌面 ${canvas.width}x${canvas.height})`)
      } else {
        setMsg('已连接 (尺寸未知)')
      }
    }
    const onConnect = (): void => {
      connected = true
      applyScale()
      showSize()
    }
    const onResize = (e: CustomEvent): void => {
      applyScale()
      const w = e.detail?.width
      const h = e.detail?.height
      setMsg(w && h ? `已连接 (桌面 ${w}x${h})` : '已连接')
    }
    const onDisconnect = (e: CustomEvent): void => {
      const clean = e.detail?.clean
      if (securityErrRef.current) {
        setMsg(securityErrRef.current)
        securityErrRef.current = ''
      } else {
        setMsg(clean ? '已断开' : '连接被服务器关闭，请检查连接信息/密码')
      }
    }
    const onCredentials = (): void => setMsg('服务器要求认证…')
    const onSecurity = (e: CustomEvent): void => {
      const reason = e.detail?.reason
      const text = reason ? `认证失败：${reason}` : '认证失败，请检查密码'
      securityErrRef.current = text
      setMsg(text)
    }

    // 剪贴板状态（用于双向同步与防回环）
    let lastClip = ''

    // 剪贴板：服务器 → 本地
    const onClipboard = (e: CustomEvent): void => {
      const text = e.detail?.text
      if (text) {
        lastClip = text
        window.api.writeClipboard(text)
      }
    }

    // 剪贴板：本地 → 服务器（定期检测变化）
    const clipTimer = window.setInterval(async () => {
      try {
        const text = await window.api.readClipboard()
        if (text && text !== lastClip) {
          lastClip = text
          rfb.clipboardPasteFrom(text)
        }
      } catch {
        /* ignore */
      }
    }, 1500)

    rfb.addEventListener('connect', onConnect)
    rfb.addEventListener('resize', onResize)
    rfb.addEventListener('disconnect', onDisconnect)
    rfb.addEventListener('credentialsrequired', onCredentials)
    rfb.addEventListener('securityfailure', onSecurity)
    rfb.addEventListener('clipboard', onClipboard)

    // 定时检测 canvas 是否有实际像素（画面渲染诊断）
    let pixelFound = false
    const pixelTimer = window.setInterval(() => {
      applyScale()
      try {
        const canvas = screen.querySelector('canvas')
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        const img = ctx?.getImageData(0, 0, canvas.width, canvas.height)?.data
        if (img && img.length > 0) {
          let nonZero = 0
          for (let i = 3; i < img.length; i += 4) if (img[i] > 0) nonZero++
          if (nonZero > 0 && !pixelFound) {
            pixelFound = true
            setMsg(`已连接 (桌面 ${canvas.width}x${canvas.height}) · 画面正常`)
            window.clearInterval(pixelTimer)
          }
        }
      } catch {
        /* ignore 读取错误 */
      }
    }, 1500)

    return () => {
      window.cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
      window.clearTimeout(timeout)
      window.clearInterval(clipTimer)
      window.clearInterval(pixelTimer)
      rfb.removeEventListener('connect', onConnect)
      rfb.removeEventListener('resize', onResize)
      rfb.removeEventListener('disconnect', onDisconnect)
      rfb.removeEventListener('credentialsrequired', onCredentials)
      rfb.removeEventListener('securityfailure', onSecurity)
      rfb.removeEventListener('clipboard', onClipboard)
      // 恢复被 patch 的坐标换算方法（恢复原始未绑定函数）
      if (display && rawAbsX && rawAbsY) {
        display.absX = rawAbsX
        display.absY = rawAbsY
      }
      try {
        rfb.disconnect()
      } catch {
        /* ignore */
      }
      rfbRef.current = null
    }
  }, [tab.sessionId, endpoint, tab.profile])

  return (
    <div className="vnc-view">
      <div className="vnc-canvas-wrap">
        <div ref={screenRef} className="vnc-screen" />
      </div>
    </div>
  )
}
