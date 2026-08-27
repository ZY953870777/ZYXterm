import { useEffect, useRef } from 'react'
import { Tab } from '../App'

interface Props {
  tab: Tab
}

// FreeRDP PTR_FLAGS（RDP 鼠标协议）
const PTR_MOVE = 0x0800
const PTR_DOWN = 0x8000
const PTR_BUTTON1 = 0x1000
const PTR_BUTTON2 = 0x2000
const PTR_BUTTON3 = 0x4000
const PTR_WHEEL = 0x0200
const PTR_WHEEL_NEGATIVE = 0x0100
const WHEEL_ROTATION = 0x78 // 120：标准一个滚轮刻度

// RDP Set1 扫描码。扩展键（方向键/编辑键/小键盘 Enter、/ 等）必须带
// KBD_FLAGS_EXTENDED(0x100) 标记，否则与同值的小键盘键冲突：
// 如 ArrowUp=0x48 与 Numpad8=0x48 相同，不带标记按↑会被当作小键盘 8 输出。
const KBD_EXTENDED = 0x100
const CODE_TO_SCAN: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
  Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a,
  Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f,
  KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25,
  KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a,
  Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x45, F12: 0x46,
  // 小键盘数字（无 E0 前缀）
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, NumpadSeparator: 0x4c,
  // 扩展键（E0 前缀，带 KBD_FLAGS_EXTENDED 标记）
  Home: KBD_EXTENDED | 0x47, ArrowUp: KBD_EXTENDED | 0x48,
  PageUp: KBD_EXTENDED | 0x49, ArrowLeft: KBD_EXTENDED | 0x4b,
  ArrowRight: KBD_EXTENDED | 0x4d, End: KBD_EXTENDED | 0x4f,
  ArrowDown: KBD_EXTENDED | 0x50, PageDown: KBD_EXTENDED | 0x51,
  Insert: KBD_EXTENDED | 0x52, Delete: KBD_EXTENDED | 0x53,
  NumpadEnter: KBD_EXTENDED | 0x1c, NumpadDivide: KBD_EXTENDED | 0x35,
  ControlRight: KBD_EXTENDED | 0x1d, AltRight: KBD_EXTENDED | 0x38,
  MetaLeft: KBD_EXTENDED | 0x5b, MetaRight: KBD_EXTENDED | 0x5c,
  ContextMenu: KBD_EXTENDED | 0x5d
}

/**
 * RDP 视图（FreeRDP 嵌入式方案）
 *
 * 通过 IPC 接收主进程 FreeRDP addon 推送的脏区帧（rdp:frame），绘制到 canvas；
 * canvas 的键盘/鼠标事件经 IPC（rdp:input）回传给 addon 注入远程桌面。
 */
// 模块级：记录每个 RDP 会话最后渲染的缓冲尺寸。组件卸载/重挂载（如切换首页、
// 多窗口分离）后 wRef 会重置，此时若 worker 仍保持旧连接（只发脏区帧、不发
// 整帧），用历史尺寸初始化缓冲可避免脏区帧被误当成全屏尺寸导致黑屏/错乱。
const lastFrameSize = new Map<string, { w: number; h: number }>()

export default function RDPView2({ tab }: Props) {
  const viewRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const fullRef = useRef<Uint8ClampedArray | null>(null) // 全屏 RGBA 缓冲
  const dirtyRef = useRef<ImageData | null>(null) // 复用的脏区 ImageData
  const wRef = useRef(0)
  const hRef = useRef(0)

  // 远程光标（在 canvas 上绘制，替代 CSS cursor——data URL 在 Electron 中不可靠）
  const cursorImgRef = useRef<ImageData | null>(null)
  const cursorHotRef = useRef({ x: 0, y: 0 })
  const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastCursorRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const mousePosRef = useRef<{ x: number; y: number } | null>(null)

  // 用远程缓冲恢复（擦除）上一次绘制的光标区域（clamp 到画布范围，避免越界残留）
  const restoreCursorRect = (): void => {
    const ctx = ctxRef.current
    const rect = lastCursorRectRef.current
    if (!ctx || !rect) return
    const W = wRef.current
    const H = hRef.current
    const full = fullRef.current
    if (W <= 0 || H <= 0 || !full) return
    const x = Math.max(0, Math.min(rect.x, W - 1))
    const y = Math.max(0, Math.min(rect.y, H - 1))
    const w = Math.min(rect.w, W - x)
    const h = Math.min(rect.h, H - y)
    if (w <= 0 || h <= 0) return
    const img = ctx.createImageData(w, h)
    for (let row = 0; row < h; row++) {
      const srcOff = ((y + row) * W + x) * 4
      if (srcOff + w * 4 <= full.length) {
        img.data.set(full.subarray(srcOff, srcOff + w * 4), row * w * 4)
      }
    }
    ctx.putImageData(img, x, y)
  }

  // 在 canvas 上绘制远程光标（alpha 混合），替代 CSS cursor（Electron 中不可靠）
  const redrawCursor = (): void => {
    const ctx = ctxRef.current
    const cur = cursorImgRef.current
    const m = mousePosRef.current
    if (!ctx || !cur || !m) return
    const W = wRef.current
    const H = hRef.current
    const full = fullRef.current
    if (W <= 0 || H <= 0 || !full) return
    restoreCursorRect() // 先擦除旧光标（用远程缓冲恢复）
    // 在鼠标位置绘制新光标（drawImage 带 alpha 混合，透明部分不遮画面）
    let cc = cursorCanvasRef.current
    if (!cc) {
      cc = document.createElement('canvas')
      cursorCanvasRef.current = cc
    }
    cc.width = cur.width
    cc.height = cur.height
    const cctx = cc.getContext('2d')
    if (!cctx) return
    cctx.putImageData(cur, 0, 0)
    const dx = Math.round(m.x - cursorHotRef.current.x)
    const dy = Math.round(m.y - cursorHotRef.current.y)
    ctx.drawImage(cc, dx, dy)
    lastCursorRectRef.current = { x: dx, y: dy, w: cur.width, h: cur.height }
  }

  // 清除光标（鼠标离开 RDP 画布时调用）
  const clearCursor = (): void => {
    restoreCursorRect()
    lastCursorRectRef.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx

    // 初始化全屏缓冲（含尺寸变化）
    const ensureBuffer = (w: number, h: number): void => {
      if (w <= 0 || h <= 0) return
      if (wRef.current === w && hRef.current === h && fullRef.current) return
      wRef.current = w
      hRef.current = h
      canvas.width = w
      canvas.height = h
      fullRef.current = new Uint8ClampedArray(w * h * 4)
      dirtyRef.current = null
      // 清屏为黑色
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
      // 记录最近一次缓冲尺寸，供卸载/重挂载后恢复
      lastFrameSize.set(tab.sessionId, { w, h })
    }

    // 重挂载兜底：若 worker 仍保持旧连接（只发脏区帧、不发整帧），用历史
    // 尺寸初始化缓冲，避免脏区帧被误当成全屏尺寸初始化导致黑屏/错乱
    const hist = lastFrameSize.get(tab.sessionId)
    if (hist && wRef.current === 0) ensureBuffer(hist.w, hist.h)

    const unsubFrame = window.api.onRdpFrame((id, frame) => {
      if (id !== tab.sessionId) return
      const { x, y, width, height, data } = frame
      if (width <= 0 || height <= 0 || !data || data.length < width * height * 4) {
        return
      }
      // 缓冲尺寸自适应：
      // - 首帧初始化缓冲
      // - 若帧超出当前缓冲：实际桌面尺寸与请求不一致（如服务器固定分辨率，
      //   且不触发 DesktopResize 回调），此时 gdi 尺寸变化后 flush_frame 必发
      //   整帧(x=0,y=0)，据此重建缓冲；否则丢弃越界帧，等整帧/resize 重建。
      //   修复：黑屏（full.set 越界抛错）、鼠标坐标错位、重连后分辨率不一致
      let W = wRef.current
      let H = hRef.current
      if (W > 0 && H > 0 && (x + width > W || y + height > H)) {
        if (x === 0 && y === 0) {
          ensureBuffer(width, height) // 整帧越界 → gdi 尺寸已变化，重建缓冲
          W = wRef.current
          H = hRef.current
        } else {
          return // 非整帧越界（异常）：丢弃，等整帧重建
        }
      }
      if (wRef.current === 0) ensureBuffer(width, height)
      W = wRef.current
      H = hRef.current
      if (W <= 0 || H <= 0 || !fullRef.current) return
      // 最终防御：帧不超出缓冲才拷贝（避免 full.set 越界抛错）
      if (x + width > W || y + height > H) return
      // 拷贝脏区到全屏缓冲（frame.data 每行 width*4 紧凑）
      const full = fullRef.current
      const src = data
      for (let row = 0; row < height; row++) {
        const srcOff = row * width * 4
        const dstOff = ((y + row) * W + x) * 4
        full.set(src.subarray(srcOff, srcOff + width * 4), dstOff)
      }
      // 局部 putImageData（只更新脏区）
      let dirty = dirtyRef.current
      if (!dirty || dirty.width !== width || dirty.height !== height) {
        dirty = ctx.createImageData(width, height)
        dirtyRef.current = dirty
      }
      const d = dirty.data
      for (let row = 0; row < height; row++) {
        const srcOff = ((y + row) * W + x) * 4
        d.set(full.subarray(srcOff, srcOff + width * 4), row * width * 4)
      }
      ctx.putImageData(dirty, x, y)
      redrawCursor() // 帧更新后重绘光标，避免被脏区覆盖
    })

    const unsubResize = window.api.onRdpResize((id, size) => {
      if (id !== tab.sessionId) return
      const [w, h] = size.split('x').map(Number)
      ensureBuffer(w, h)
    })

    // RDP 服务器下发光标形状 → 保存光标并在 canvas 上绘制（跨平台可靠，
    // CSS cursor 的 data URL 在 Electron 中不可靠，始终回退箭头）
    const unsubPointer = window.api.onRdpPointer((id, ptr) => {
      if (id !== tab.sessionId) return
      if (!ptr || ptr.width <= 0 || ptr.height <= 0) return
      if (!ptr.data || ptr.data.length < ptr.width * ptr.height * 4) return
      try {
        cursorImgRef.current = new ImageData(
          new Uint8ClampedArray(ptr.data),
          ptr.width,
          ptr.height
        )
        cursorHotRef.current = { x: ptr.x, y: ptr.y }
        redrawCursor()
      } catch {
        /* ignore */
      }
    })

    // 跟随容器尺寸动态调整远程分辨率（铺满容器）
    // 主进程侧 resize() 会 kill 旧 worker 并按新尺寸重连，故加 300ms debounce
    // 避免拖动窗口/面板时频繁重连；measure 有尺寸去重（相同尺寸不再上报，
    // 配合主进程 resize() 去重，杜绝重复上报导致的反复重连循环）。
    const view = viewRef.current
    let resizeTimer = 0
    let rafId = 0
    let lastW = 0
    let lastH = 0
    const measure = (): void => {
      if (!view) return
      const w = Math.floor(view.clientWidth)
      const h = Math.floor(view.clientHeight)
      if (w <= 0 || h <= 0) return
      // 极小尺寸（标签切换时的布局中间态）不上报，避免触发极小分辨率重连
      if (w < 50 || h < 50) return
      if (w === lastW && h === lastH) return // 尺寸未变：跳过
      lastW = w
      lastH = h
      window.api.rdpSetSize(tab.sessionId, w, h)
    }
    // 所有 ResizeObserver 回调统一 debounce（含挂载后的首次布局回调，保证
    // 布局稳定后的真实尺寸一定会上报，避免首次连接用默认尺寸导致未铺满）
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        rafId = window.requestAnimationFrame(measure)
      }, 300)
    })
    if (view) {
      ro.observe(view)
      // 布局可能尚未完成，先用 rAF 延迟一次确保拿到最终容器尺寸
      rafId = window.requestAnimationFrame(() => {
        measure()
        // 布局完成前的首帧尺寸可能偏小，rAF 后再补一次
        window.setTimeout(measure, 100)
      })
    }

    return () => {
      unsubFrame()
      unsubResize()
      unsubPointer()
      ro.disconnect()
      window.clearTimeout(resizeTimer)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId])

  // canvas CSS 坐标 → 逻辑像素（防御空尺寸/越界）
  const toLogical = (e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
    const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width))
    const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height))
    return {
      x: Math.max(0, Math.min(x, canvas.width - 1)),
      y: Math.max(0, Math.min(y, canvas.height - 1))
    }
  }

  const sendMouse = (x: number, y: number, flags: number): void => {
    window.api.rdpInput(tab.sessionId, { type: 'mouse', x, y, flags })
  }

  const handleMouse = (e: React.MouseEvent, down: boolean): void => {
    const { x, y } = toLogical(e)
    const btnFlag = e.button === 2 ? PTR_BUTTON2 : e.button === 1 ? PTR_BUTTON3 : PTR_BUTTON1
    sendMouse(x, y, (down ? PTR_DOWN : 0) | btnFlag)
  }

  return (
    <div className="rdp-view2" ref={viewRef}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ outline: 'none', cursor: 'none' }}
        onMouseMove={(e) => {
          const p = toLogical(e)
          mousePosRef.current = p
          sendMouse(p.x, p.y, PTR_MOVE)
          redrawCursor() // 光标跟随鼠标移动
        }}
        onMouseLeave={() => {
          clearCursor() // 离开画布时擦除远程光标，避免残留
          mousePosRef.current = null
        }}
        onMouseDown={(e) => handleMouse(e, true)}
        onMouseUp={(e) => handleMouse(e, false)}
        onWheel={(e) => {
          // RDP 滚轮：PTR_FLAGS_WHEEL + 方向标志 + 旋转量
          e.preventDefault()
          const delta = e.deltaY
          if (delta === 0) return
          const { x, y } = toLogical(e)
          const flags =
            PTR_WHEEL | (delta > 0 ? PTR_WHEEL_NEGATIVE : 0) | WHEEL_ROTATION
          sendMouse(x, y, flags)
        }}
        onKeyDown={(e) => {
          const scan = CODE_TO_SCAN[e.code]
          if (scan !== undefined) {
            e.preventDefault()
            window.api.rdpInput(tab.sessionId, { type: 'key', scancode: scan, pressed: true })
          }
        }}
        onKeyUp={(e) => {
          const scan = CODE_TO_SCAN[e.code]
          if (scan !== undefined) {
            e.preventDefault()
            window.api.rdpInput(tab.sessionId, { type: 'key', scancode: scan, pressed: false })
          }
        }}
      />
      {tab.status === 'connecting' && <div className="rdp-msg">正在连接…</div>}
      {tab.status === 'error' && <div className="rdp-msg">{tab.message ?? '连接失败'}</div>}
    </div>
  )
}
