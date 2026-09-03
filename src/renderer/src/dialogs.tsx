/**
 * 全局自绘 弹窗/确认框（替代原生 window.alert / window.confirm）
 *
 * 为什么：Electron 的原生 alert/confirm 关闭后不会把 DOM/窗口焦点还回原处，
 * 导致其后 SSH 终端等页面“键入无反应”。这里用独立的 React 根挂一个覆盖层，
 * 关闭时自动把焦点还给打开前的元素（如 xterm 的隐藏 textarea）。
 */
import { useSyncExternalStore } from 'react'
import { createRoot, Root } from 'react-dom/client'

interface DialogReq {
  kind: 'alert' | 'confirm'
  message: string
  danger?: boolean
  okText?: string
  resolve: (ok: boolean) => void
  prevFocus: HTMLElement | null
}

interface ShowOpts {
  kind: 'alert' | 'confirm'
  message: string
  danger?: boolean
  okText?: string
}

let queue: DialogReq[] = []
let current: DialogReq | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function getSnapshot(): DialogReq | null {
  return current
}

let root: Root | null = null
function ensureHost(): void {
  if (root) return
  const el = document.createElement('div')
  el.id = 'zyxterm-ui-dialog-host'
  document.body.appendChild(el)
  root = createRoot(el)
  root.render(<Host />)
}

/** 显示一个弹窗，返回用户是否“确定”（alert 恒 true） */
export function showDialog(opts: ShowOpts): Promise<boolean> {
  ensureHost()
  return new Promise<boolean>((resolve) => {
    const prevFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    queue.push({ ...opts, resolve, prevFocus })
    if (!current) current = queue.shift() ?? null
    emit()
  })
}

/** 提示（只有一个“知道了”） */
export function uiAlert(message: string): Promise<void> {
  return showDialog({ kind: 'alert', message }).then(() => undefined)
}

/** 确认框（确定/取消），返回是否确定 */
export function uiConfirm(
  message: string,
  opts?: { danger?: boolean; okText?: string }
): Promise<boolean> {
  return showDialog({
    kind: 'confirm',
    message,
    danger: opts?.danger,
    okText: opts?.okText
  })
}

function finish(ok: boolean): void {
  const done = current
  current = queue.shift() ?? null
  done?.resolve(ok)
  // 把焦点还给打开弹窗前的元素（如 xterm 隐藏 textarea），避免“键入无反应”
  const pf = done?.prevFocus
  if (pf) {
    requestAnimationFrame(() => {
      try {
        if (pf.isConnected) pf.focus()
      } catch {
        /* ignore */
      }
    })
  }
  emit()
}

function Host() {
  const d = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!d) return null
  const isConfirm = d.kind === 'confirm'
  return (
    <div
      className="dialog-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false)
      }}
    >
      <div className="dialog confirm-dialog">
        <div className="dialog-header">
          <h2>{isConfirm ? '提示' : '提示'}</h2>
          <button className="dialog-close" onClick={() => finish(false)}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="confirm-text">{d.message}</p>
          <div className="confirm-actions">
            {isConfirm && (
              <button className="btn-cancel" onClick={() => finish(false)}>
                取消
              </button>
            )}
            <button
              className={`btn-primary${d.danger ? ' confirm-danger' : ''}`}
              onClick={() => finish(true)}
            >
              {d.okText ?? (isConfirm ? '确定' : '知道了')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
