import { useMemo } from 'react'
import { SerialMacroScript, SerialMacroStatus } from '@shared/types'

interface Props {
  script: SerialMacroScript
  status: SerialMacroStatus | null
  onStop: () => void
  onClose: () => void
}

/** 自动化运行进度页：显示原始命令逐行高亮 + 轮次/步骤进度 + 停止按钮 */
export default function SerialMacroProgress({ script, status, onStop, onClose }: Props) {
  const running = status?.running === true
  const state = status?.state ?? (running ? 'running' : 'idle')

  const lines = useMemo(() => script.text.split(/\r?\n/), [script.text])

  // 每个原始行对应的步骤序号（空行/注释为 null）
  const lineSteps = useMemo(() => {
    let step = 0
    return lines.map((raw) => {
      const line = raw.trim()
      if (!line || line.startsWith('#')) return null
      return step++
    })
  }, [lines])

  const lineClass = (i: number): string => {
    const step = lineSteps[i]
    if (step === null) return 'macro-line note'
    if (state === 'done') return 'macro-line done'
    if (state === 'running') {
      if (step < (status?.idx ?? 0)) return 'macro-line done'
      if (step === status?.idx) return 'macro-line current'
      return 'macro-line'
    }
    // stopped / error / idle
    if (step < (status?.idx ?? 0) && state === 'error') return 'macro-line done'
    return 'macro-line'
  }

  const mark = (i: number): string => {
    const step = lineSteps[i]
    if (step === null) return '·'
    if (state === 'done') return '✓'
    if (state === 'running') {
      if (step < (status?.idx ?? 0)) return '✓'
      if (step === status?.idx) return '▶'
      return '·'
    }
    return '·'
  }

  return (
    <div className="dialog-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog macro-progress">
        <div className="dialog-header">
          <h2>自动化进度 · {script.name}</h2>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dialog-body">
          <div className="mp-meta">
            <span className={`mp-state ${state}`}>
              {state === 'running'
                ? '运行中'
                : state === 'done'
                  ? '已完成'
                  : state === 'stopped'
                    ? '已停止'
                    : state === 'error'
                      ? '失败'
                      : '待运行'}
            </span>
            <span className="mp-loop">
              循环：{script.loop === -1 ? '无限' : `${script.loop} 次`}
            </span>
            {running && (
              <span className="mp-iter">
                第 {status?.iter ?? 1} 轮
                {script.loop !== -1 ? ` / ${script.loop}` : ''} · 步骤{' '}
                {Math.min((status?.idx ?? 0) + 1, status?.total ?? 1)}/{status?.total ?? 1}
              </span>
            )}
          </div>

          {running && status?.message && <div className="mp-cur">{status.message}</div>}

          {status && !running && status.state === 'error' && status.message && (
            <div className="mp-cur err">{status.message}</div>
          )}

          <div className="mp-progress">
            <div
              className="mp-fill"
              style={{
                width:
                  running && script.loop !== -1 && status?.iter && status?.total
                    ? `${Math.min(
                        100,
                        Math.round(
                          (((status.iter - 1) * status.total + (status.idx + 1)) /
                            (script.loop * status.total)) *
                            100
                        )
                      )}%`
                    : running
                      ? '8%'
                      : state === 'done'
                        ? '100%'
                        : '0%'
              }}
            />
          </div>

          <div className="mp-lines">
            {lines.map((l, i) => (
              <div key={i} className={lineClass(i)}>
                <span className="mp-mark">{mark(i)}</span>
                <code>{l || ' '}</code>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-footer macro-actions">
          {running ? (
            <button className="btn-primary confirm-danger" onClick={onStop}>
              ⏹ 停止
            </button>
          ) : (
            <button className="btn-primary" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
