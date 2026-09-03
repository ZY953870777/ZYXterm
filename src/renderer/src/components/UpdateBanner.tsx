import { useEffect, useState } from 'react'
import { UpdaterState } from '@shared/types'

/**
 * 自动更新提示条（右下角浮层）
 * - available → 提示"发现新版本"，可下载/稍后
 * - downloading → 进度条
 * - downloaded → 提示"重启并安装"
 * - error → 静默（主进程已每小时自动循环检测，失败无需手动重试）
 */
export default function UpdateBanner() {
  const [upd, setUpd] = useState<UpdaterState>({ state: 'idle' })

  useEffect(() => {
    const unsub = window.api.onUpdaterStatus((s) => setUpd(s))
    return unsub
  }, [])

  if (
    upd.state === 'idle' ||
    upd.state === 'checking' ||
    upd.state === 'not-available' ||
    upd.state === 'error'
  ) {
    // 检测/更新失败：静默不打扰（主进程已每小时自动循环检测，无需手动重试）
    return null
  }

  if (upd.state === 'available') {
    return (
      <div className="update-banner">
        <span className="update-msg">
          发现新版本 <b>v{upd.version}</b>
        </span>
        {upd.notes && <div className="update-notes">{upd.notes}</div>}
        <button onClick={() => window.api.downloadUpdate()}>下载</button>
        <button className="ghost" onClick={() => setUpd({ state: 'idle' })}>
          稍后
        </button>
      </div>
    )
  }

  if (upd.state === 'downloading') {
    return (
      <div className="update-banner">
        <span className="update-msg">正在下载更新… {upd.percent}%</span>
        <div className="update-progress">
          <div className="update-bar" style={{ width: `${upd.percent}%` }} />
        </div>
      </div>
    )
  }

  // downloaded
  return (
    <div className="update-banner success">
      <span className="update-msg">
        新版本 <b>v{upd.version}</b> 已就绪，重启后安装
      </span>
      <button onClick={() => window.api.installUpdate()}>重启并安装</button>
    </div>
  )
}
