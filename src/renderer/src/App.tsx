import { useCallback, useEffect, useRef, useState } from 'react'
import { uiAlert, uiConfirm, uiPrompt } from './dialogs'
import { parseGlobalMacro } from './globalMacroParser'
import GlobalMacroDialog from './components/GlobalMacroDialog'
import GlobalMacroProgress from './components/GlobalMacroProgress'
import type {
  ConfigBackup,
  GlobalMacroScript,
  GlobalMacroStatus,
  GlobalMacroTarget
} from '@shared/types'
import {
  ConnectionProfile,
  NewProfileInput,
  ProtocolType,
  SessionInfo
} from '@shared/types'
import SessionTabs from './components/SessionTabs'
import SessionView from './components/SessionView'
import FullscreenView from './components/FullscreenView'
import ConnectionGrid from './components/ConnectionGrid'
import QuickConnectDialog from './components/QuickConnectDialog'
import NewConnectionDialog from './components/NewConnectionDialog'
import UpdateBanner from './components/UpdateBanner'

/** 首页伪 tab id（固定 tab，不可拖拽/关闭） */
export const HOME_ID = '__home__'

/** 打开的会话标签页 */
export interface Tab {
  sessionId: string
  name: string
  protocol: ProtocolType
  status: SessionInfo['status']
  message?: string
  wsEndpoint?: string
  profile: ConnectionProfile
}

/** 参与导出/导入的渲染层持久化键（localStorage）。
 *  路径记忆类键（日志/XMODEM 上次路径）与本机相关，不导出。 */
const CONFIG_PREF_KEYS = [
  'zyxterm-col-order', // 首页类别列顺序
  'zyxterm:serial-macros', // 串口自动化脚本
  'zyxterm:global-macros', // 跨会话联动自动化脚本
  'zyxterm:global-targets', // 联动脚本上次选中的连接
  'zyxterm:gm-script-targets', // 各联动脚本各自记住的目标连接
  'zyxterm:quick-commands' // 终端快捷命令分组
] as const

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string>(HOME_ID)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editProfile, setEditProfile] = useState<ConnectionProfile | null>(null)
  const [newProtocol, setNewProtocol] = useState<ProtocolType>('ssh')
  const [quickOpen, setQuickOpen] = useState(false)
  // 跨会话（多 SSH/串口）联动自动化
  const [gmOpen, setGmOpen] = useState(false)
  const [gmRunOpen, setGmRunOpen] = useState(false)
  const [gmStatus, setGmStatus] = useState<GlobalMacroStatus | null>(null)
  const [gmTargets, setGmTargets] = useState<GlobalMacroTarget[]>([])
  const [gmScript, setGmScript] = useState<GlobalMacroScript | null>(null)
  const [rdpAvailable, setRdpAvailable] = useState(true)
  // 自定义标题栏：窗口是否处于最大化（切换 最大化/还原 按钮图标）
  const [maximized, setMaximized] = useState(false)
  // 全屏：窗口是否处于全屏（铺满显示器）；全屏时隐藏标题栏/标签栏
  const [appFullscreen, setAppFullscreen] = useState(false)
  // 右击 tab 编辑时的来源 tab 会话 id：保存后按新参数刷新该 tab（不新开）
  const [editSessionId, setEditSessionId] = useState<string | null>(null)
  const editSessionIdRef = useRef<string | null>(null)
  // 导入配置后自增，强制首页网格重新挂载（重新读取列顺序等 localStorage）
  const [gridRev, setGridRev] = useState(0)

  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const tabsRef = useRef<Tab[]>([])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // 各会话最新状态缓存：连接很快的协议（如 VNC）可能在 createSession 的
  // IPC 返回前就上报了 connected，事件到达时 tab 尚未创建会被丢弃，
  // 建 tab 时优先取这里的缓存，避免卡在 connecting
  const latestStatusRef = useRef<Map<string, SessionInfo>>(new Map())

  // 自定义标题栏：初始读取最大化状态 + 订阅主进程最大化/还原事件
  useEffect(() => {
    window.api.isMaximized().then(setMaximized)
    return window.api.onMaximized(setMaximized)
  }, [])

  // 全屏状态：由主进程事件 + 乐观更新驱动（初始 false；主进程启动时已强制
  // setFullScreen(false) 清除残留）。不使用 isFullScreen() 初始查询/轮询，
  // 避免残留状态误判为全屏导致标题栏被隐藏
  useEffect(() => {
    return window.api.onFullScreen(setAppFullscreen)
  }, [])

  // 初始化：加载配置、检测 RDP、订阅状态事件
  useEffect(() => {
    window.api.listProfiles().then(setProfiles)
    window.api
      .detectRdp()
      .then((r) => setRdpAvailable(r.available))
      .catch(() => setRdpAvailable(false))

    const unsub = window.api.onConnectionStatus((info: SessionInfo) => {
      latestStatusRef.current.set(info.sessionId, info)
      setTabs((prev) =>
        prev.map((t) =>
          t.sessionId === info.sessionId
            ? {
                ...t,
                status: info.status,
                message: info.message,
                wsEndpoint: info.wsEndpoint ?? t.wsEndpoint
              }
            : t
        )
      )
    })
    return unsub
  }, [])

  // 多窗口：注册本窗口，监听从其他窗口移交的会话（分离/合并/初始化接管）
  useEffect(() => {
    window.api.registerWindow()
    const unsubAttach = window.api.onAttachTab((profile, sessionId) => {
      void adoptSession(profile, sessionId)
    })
    const unsubInit = window.api.onInitProfile((profile, sessionId) => {
      void adoptSession(profile, sessionId)
    })
    return () => {
      unsubAttach()
      unsubInit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // tabs 变化时上报主进程（用于判断独立窗口是否可关闭）
  useEffect(() => {
    window.api.notifyTabsChanged(tabs.map((t) => t.sessionId))
  }, [tabs])

  /** 建 tab 时读取状态缓存，避免覆盖比 IPC 快照更新的状态 */
  const cachedInfo = (sessionId: string): SessionInfo | undefined =>
    latestStatusRef.current.get(sessionId)

  /** 接管一个已存在（或新分离）的会话，不重新发起连接 */
  const adoptSession = useCallback(
    async (profile: ConnectionProfile, sessionId: string) => {
      try {
        const info = (await window.api.listSessions()).find(
          (s) => s.sessionId === sessionId
        )
        const fresh = cachedInfo(sessionId) ?? info
        const tab: Tab = {
          sessionId,
          name: profile.name,
          protocol: profile.protocol,
          status: fresh?.status ?? 'connecting',
          message: fresh?.message,
          wsEndpoint: fresh?.wsEndpoint ?? info?.wsEndpoint,
          profile
        }
        setTabs((prev) => [...prev, tab])
        setActiveId(sessionId)
      } catch (e) {
        console.error('接管会话失败:', e)
      }
    },
    []
  )

  /** 移动 tab 出本窗口（分离/合并），仅移除 UI，不关闭会话 */
  const moveTabOut = useCallback((sessionId: string) => {
    setTabs((prev) => prev.filter((t) => t.sessionId !== sessionId))
    setActiveId((prev) => (prev === sessionId ? HOME_ID : prev))
  }, [])

  const handleDetachTab = useCallback(
    async (tab: Tab) => {
      await window.api.detachTab(tab.profile, tab.sessionId)
      moveTabOut(tab.sessionId)
    },
    [moveTabOut]
  )

  const handleAttachTab = useCallback(
    async (tab: Tab, targetWindowId: number) => {
      await window.api.attachTab(tab.profile, tab.sessionId, targetWindowId)
      moveTabOut(tab.sessionId)
    },
    [moveTabOut]
  )

  // tab 切换后把焦点交给激活页面（终端/RDP/VNC 的可聚焦元素），便于直接输入
  const focusActivePane = useCallback((): void => {
    // 等 React 完成激活 pane 渲染（双 rAF）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const pane = document.querySelector<HTMLElement>(
          '.session-pane[data-active="true"]'
        )
        if (!pane) return
        const el = pane.querySelector<HTMLElement>(
          'textarea, canvas, [tabindex]:not([tabindex="-1"])'
        )
        el?.focus()
      })
    })
  }, [])

  const openProfile = useCallback(async (profile: ConnectionProfile) => {
    try {
      const info = await window.api.createSession(profile)
      const fresh = cachedInfo(info.sessionId) ?? info
      const tab: Tab = {
        sessionId: info.sessionId,
        name: info.name,
        protocol: info.protocol,
        status: fresh.status,
        message: fresh.message,
        wsEndpoint: fresh.wsEndpoint ?? info.wsEndpoint,
        profile
      }
      setTabs((prev) => [...prev, tab])
      setActiveId(info.sessionId)
      // 新会话 pane 挂载后把焦点交给它（SSH 终端等可直接输入）
      focusActivePane()
    } catch (e) {
      void uiAlert(`连接失败: ${(e as Error).message}`)
    }
  }, [focusActivePane])

  const closeTab = useCallback(async (sessionId: string) => {
    await window.api.closeSession(sessionId)
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.sessionId === sessionId)
      const next = prev.filter((t) => t.sessionId !== sessionId)
      if (activeIdRef.current === sessionId) {
        const neighbor = next[Math.max(0, idx - 1)]
        setActiveId(neighbor ? neighbor.sessionId : HOME_ID)
      }
      return next
    })
  }, [])

  /** 重新连接：关闭原会话并重新打开同一配置 */
  const reconnectTab = useCallback(
    async (tab: Tab) => {
      await window.api.closeSession(tab.sessionId)
      setTabs((prev) => prev.filter((t) => t.sessionId !== tab.sessionId))
      setActiveId((prev) => (prev === tab.sessionId ? HOME_ID : prev))
      await openProfile(tab.profile)
    },
    [openProfile]
  )

  /** 编辑保存后刷新当前 tab：关闭原会话，按新 profile 重连，替换原 tab（保留位置） */
  const refreshTab = useCallback(
    async (profile: ConnectionProfile, oldSessionId: string) => {
      try {
        await window.api.closeSession(oldSessionId)
        const info = await window.api.createSession(profile)
        const fresh = cachedInfo(info.sessionId) ?? info
        const tab: Tab = {
          sessionId: info.sessionId,
          name: info.name,
          protocol: info.protocol,
          status: fresh.status,
          message: fresh.message,
          wsEndpoint: fresh.wsEndpoint ?? info.wsEndpoint,
          profile
        }
        setTabs((prev) => prev.map((t) => (t.sessionId === oldSessionId ? tab : t)))
        setActiveId((prev) => (prev === oldSessionId ? info.sessionId : prev))
        focusActivePane()
      } catch (e) {
        void uiAlert(`连接失败: ${(e as Error).message}`)
      }
    },
    [focusActivePane]
  )

  /** 拖动 tab 左右换位置 */
  const reorderTab = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  const openNew = useCallback((protocol: ProtocolType = 'ssh') => {
    setNewProtocol(protocol)
    setEditProfile(null)
    setDialogOpen(true)
  }, [])

  const openEdit = useCallback((profile: ConnectionProfile, fromTab?: Tab) => {
    setNewProtocol(profile.protocol)
    setEditProfile(profile)
    // 记录编辑来源：右击 tab 编辑时携带该 tab 的 sessionId，保存后刷新该 tab
    setEditSessionId(fromTab?.sessionId ?? null)
    editSessionIdRef.current = fromTab?.sessionId ?? null
    setDialogOpen(true)
  }, [])

  const handleDeleteProfile = useCallback(
    async (id: string) => {
      // 自绘确认框（原生 window.confirm 会夺走焦点且关闭后不归还，导致 SSH 键入异常）
      const ok = await uiConfirm('确定删除该连接配置？', { danger: true })
      if (!ok) return
      await window.api.deleteProfile(id)
      setProfiles((prev) => prev.filter((p) => p.id !== id))
    },
    []
  )

  // ---------- 跨会话（多 SSH/串口）联动自动化 ----------
  useEffect(() => {
    const unsub = window.api.onGlobalMacroStatus((st) => setGmStatus(st))
    return unsub
  }, [])

  const runGlobalMacro = useCallback(
    async (targets: GlobalMacroTarget[], script: GlobalMacroScript): Promise<void> => {
      const { steps, error } = parseGlobalMacro(script.text)
      if (error || steps.length === 0) {
        void uiAlert(error || '脚本为空')
        return
      }
      for (const st of steps) {
        if (st.op !== 'sleep' && (st.target < 0 || st.target >= targets.length)) {
          void uiAlert(
            `脚本引用了会话 ID ${st.target}，但只选了 ${targets.length} 个会话（顺序从 0 开始）`
          )
          return
        }
      }
      setGmTargets(targets)
      setGmScript(script)
      setGmOpen(false)
      setGmRunOpen(true)
      const res = await window.api.globalMacroStart({
        targets: targets.map((t) => t.sessionId),
        steps,
        loop: script.loop
      })
      if (!res.ok) {
        void uiAlert(res.error ?? '启动失败')
        setGmRunOpen(false)
      }
    },
    []
  )

  const stopGlobalMacro = useCallback((): void => {
    window.api.globalMacroStop()
  }, [])

  const handleSaveProfile = useCallback(
    async (input: NewProfileInput, connectNow: boolean) => {
      let profile: ConnectionProfile
      if (editProfile) {
        profile = await window.api.updateProfile({ ...editProfile, ...input })
        setProfiles((prev) => prev.map((p) => (p.id === profile.id ? profile : p)))
      } else {
        profile = await window.api.saveProfile(input)
        setProfiles((prev) => [...prev, profile])
      }
      const fromSessionId = editSessionIdRef.current
      editSessionIdRef.current = null
      setEditSessionId(null)
      setDialogOpen(false)
      setEditProfile(null)
      // 右击 tab 编辑：若该 tab 仍打开，按新参数刷新（重连）当前 tab，不新开
      if (
        fromSessionId &&
        tabsRef.current.some((t) => t.sessionId === fromSessionId)
      ) {
        await refreshTab(profile, fromSessionId)
      } else if (connectNow) {
        await openProfile(profile)
      }
    },
    [editProfile, openProfile, refreshTab]
  )

  // 首页列表排序：主进程在同协议类别内重排并持久化，返回新列表
  const handleReorderProfiles = useCallback(
    async (protocol: ProtocolType, fromId: string, toId: string) => {
      try {
        const next = await window.api.reorderProfiles(protocol, fromId, toId)
        setProfiles(next)
      } catch (e) {
        console.error('列表排序失败:', e)
      }
    },
    []
  )

  // ---------- 配置导出/导入 ----------

  /** 导出：收集连接配置 + 渲染层持久化偏好，输入口令后由主进程整体
   *  AES-256-GCM 加密写文件（口令不落盘，导入时凭口令解密） */
  const handleExportConfig = useCallback(async () => {
    const pass = await uiPrompt('请设置导出文件的加密口令（至少 4 个字符，\n导入时需要凭此口令解密）：', {
      okText: '下一步',
      password: true,
      placeholder: '加密口令'
    })
    if (pass == null) return
    if (pass.length < 4) {
      void uiAlert('口令至少 4 个字符，已取消导出')
      return
    }
    const pass2 = await uiPrompt('请再次输入口令确认：', {
      okText: '导出',
      password: true,
      placeholder: '确认口令'
    })
    if (pass2 == null) return
    if (pass !== pass2) {
      void uiAlert('两次输入的口令不一致，已取消导出')
      return
    }
    const prefs: Record<string, unknown> = {}
    for (const key of CONFIG_PREF_KEYS) {
      const raw = localStorage.getItem(key)
      if (raw == null) continue
      try {
        prefs[key] = JSON.parse(raw)
      } catch {
        /* 跳过无法解析的脏数据 */
      }
    }
    const backup: ConfigBackup = {
      app: 'zyxterm',
      format: 1,
      exportedAt: new Date().toISOString(),
      profiles,
      preferences: prefs
    }
    try {
      const res = await window.api.exportConfig(backup, pass)
      if (res.canceled) return
      if (res.ok) {
        void uiAlert(
          `导出成功（${backup.profiles.length} 个连接）。\n文件已整体加密，导入时凭口令解密。\n${res.path ?? ''}`
        )
      } else {
        void uiAlert(`导出失败: ${res.error ?? '未知错误'}`)
      }
    } catch (e) {
      void uiAlert(`导出失败: ${(e as Error).message}`)
    }
  }, [profiles])

  /** 合并渲染层偏好（localStorage）：
   *  - 带 id 的列表（自动化脚本、快捷命令分组）：按 id 合并，已存在保留本地
   *  - 目标连接记忆（联动脚本选中的连接）：以导入为准
   *  - 类别列顺序：保留本地（属本机布局偏好，不覆盖） */
  const mergePreferences = useCallback((prefs: Record<string, unknown>): void => {
    const ARRAY_MERGE_KEYS = [
      'zyxterm:serial-macros',
      'zyxterm:global-macros',
      'zyxterm:quick-commands'
    ]
    for (const key of CONFIG_PREF_KEYS) {
      if (!(key in prefs)) continue
      const incoming = prefs[key]
      if (ARRAY_MERGE_KEYS.includes(key) && Array.isArray(incoming)) {
        try {
          const local: unknown[] = JSON.parse(localStorage.getItem(key) ?? '[]')
          const localIds = new Set(
            local.map((x) => (x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined))
          )
          const merged = [...(Array.isArray(local) ? local : [])]
          for (const item of incoming) {
            const id =
              item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
            if (id == null || localIds.has(id)) continue
            merged.push(item)
            localIds.add(id)
          }
          localStorage.setItem(key, JSON.stringify(merged))
        } catch {
          localStorage.setItem(key, JSON.stringify(incoming))
        }
      } else {
        localStorage.setItem(key, JSON.stringify(incoming))
      }
    }
  }, [])

  /** 导入：选文件 → 凭口令解密 → 校验 → 合并式导入
   *  （连接按 id 增量合并，已存在保留本地；已打开的会话不受影响） */
  const handleImportConfig = useCallback(async () => {
    let res
    try {
      res = await window.api.importConfig()
    } catch (e) {
      void uiAlert(`导入失败: ${(e as Error).message}`)
      return
    }
    if (res.canceled) return
    if (!res.ok || !res.file) {
      void uiAlert(res.error ?? '导入失败')
      return
    }
    const pass = await uiPrompt(
      `请输入该配置文件的解密口令\n（导出于 ${res.file.meta.exportedAt.replace('T', ' ').slice(0, 19)}，含 ${res.file.meta.profileCount} 个连接）：`,
      { okText: '解密', password: true, placeholder: '解密口令' }
    )
    if (pass == null) return
    let dec
    try {
      dec = await window.api.decryptConfig(res.file, pass)
    } catch (e) {
      void uiAlert(`导入失败: ${(e as Error).message}`)
      return
    }
    if (!dec.ok) {
      void uiAlert(dec.error ?? '解密失败')
      return
    }
    const backup = dec.data as ConfigBackup | undefined
    if (
      !backup ||
      backup.app !== 'zyxterm' ||
      backup.format !== 1 ||
      !Array.isArray(backup.profiles)
    ) {
      void uiAlert('配置文件内容无效（可能已损坏）')
      return
    }
    const ok = await uiConfirm(
      `将合并导入 ${backup.profiles.length} 个连接配置及自动化脚本等偏好：\n` +
        '新增的会添加，与本机已有配置同 id 的将保留本机版本。\n已打开的会话不受影响，是否继续？',
      { okText: '合并导入' }
    )
    if (!ok) return
    try {
      const mr = await window.api.mergeProfiles(backup.profiles)
      setProfiles(mr.profiles)
      mergePreferences(backup.preferences ?? {})
      setGridRev((v) => v + 1)
      void uiAlert(
        `导入完成：新增 ${mr.added} 个连接` +
          (mr.skipped > 0 ? `，${mr.skipped} 个已存在（保留本机版本）` : '') +
          '；自动化脚本/快捷命令已按 id 合并。'
      )
    } catch (e) {
      void uiAlert(`导入失败: ${(e as Error).message}`)
    }
  }, [mergePreferences])

  // 覆盖弹窗（快捷选择/新建编辑/删除确认等原生 confirm 关闭后）关闭时，
  // 把键盘焦点还给当前会话页——否则 SSH 终端等会“键入无反应/输入不正常”
  const anyOverlayOpen = quickOpen || dialogOpen
  const prevOverlayRef = useRef(anyOverlayOpen)
  useEffect(() => {
    if (prevOverlayRef.current && !anyOverlayOpen) focusActivePane()
    prevOverlayRef.current = anyOverlayOpen
  }, [anyOverlayOpen, focusActivePane])

  // 全屏进/出：乐观更新全局状态（立即隐藏/恢复标题栏）+ 主进程窗口全屏
  const enterFullscreen = useCallback(() => {
    setAppFullscreen(true)
    window.api.setFullScreen(true)
    focusActivePane()
  }, [focusActivePane])

  const exitFullscreen = useCallback(() => {
    setAppFullscreen(false)
    window.api.setFullScreen(false)
  }, [])

  const handleSelectTab = useCallback(
    (id: string) => {
      setActiveId(id)
      if (id !== HOME_ID) focusActivePane()
    },
    [focusActivePane]
  )

  return (
    <div className={`app${appFullscreen ? ' app-fullscreen' : ''}`}>
      {/* 自定义标题栏：应用名 + 标签栏 + 窗口控制按钮 合并为一行（Chrome/VS Code 风格）。
          整行 -webkit-app-region: drag 可拖动窗口；标签/按钮为 no-drag 可交互。 */}
      <div
        className="titlebar"
        onDoubleClick={(e) => {
          // 双击标题栏空白 → 最大化/还原；标签、加号、软件名、窗口按钮不触发
          if (
            (e.target as HTMLElement).closest(
              '.tab, .tab-add, .window-controls, .titlebar-brand'
            )
          )
            return
          window.api.toggleMaximizeWindow()
        }}
      >
        {/* 软件名即「首页」入口：点击回到首页（no-drag 才能响应点击） */}
        <div
          className="titlebar-brand"
          title="回到首页"
          onClick={() => setActiveId(HOME_ID)}
        >
          ZYXterm
        </div>
        <SessionTabs
          tabs={tabs}
          activeId={activeId}
          onSelect={handleSelectTab}
          onClose={closeTab}
          onAdd={() => setQuickOpen(true)}
          onReconnect={reconnectTab}
          onEdit={(tab) => openEdit(tab.profile, tab)}
          onReorder={reorderTab}
          onDetachTab={handleDetachTab}
          onAttachTab={handleAttachTab}
        />
        {/* 跨会话联动自动化入口：运行中点击打开进度页（含停止），否则打开配置框 */}
        <button
          className={`win-btn gm-window${gmStatus?.running ? ' running' : ''}`}
          title={
            gmStatus?.running
              ? '联动自动化运行中：点击打开进度页（含停止）'
              : '联动自动化（跨多个 SSH/串口，TX/RX/sleep，可循环）'
          }
          onClick={() => (gmStatus?.running ? setGmRunOpen(true) : setGmOpen(true))}
        >
          🧩{gmStatus?.running ? ` ${gmStatus.iter}/${gmStatus.loop === -1 ? '∞' : gmStatus.loop}` : ''}
        </button>
        {/* 窗口控制按钮（macOS 使用系统红绿灯，隐藏自定义按钮） */}
        {window.api.platform !== 'darwin' && (
          <div className="window-controls">
            <button
              className="win-btn"
              title="最小化"
              onClick={() => window.api.minimizeWindow()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              className="win-btn"
              title={maximized ? '还原' : '最大化'}
              onClick={() => window.api.toggleMaximizeWindow()}
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M2.5 2.5v-1.5h7v7h-1.5" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              )}
            </button>
            <button
              className="win-btn win-close"
              title="关闭"
              onClick={() => window.api.closeWindow()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
                <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="main">
        <div className="content">
          {/* 首页：独立 pane 覆盖显示；会话 pane 始终保持挂载（切走不销毁，
              避免 RDP/VNC canvas 缓冲重置导致切回黑屏）。用 block 保持
              ConnectionGrid 内部 grid 多列布局（flex 会压缩列宽成一列） */}
          <div className="home-pane" style={{ display: activeId === HOME_ID ? 'block' : 'none' }}>
            <ConnectionGrid
              key={gridRev}
              profiles={profiles}
              rdpAvailable={rdpAvailable}
              onOpen={openProfile}
              onNew={openNew}
              onEdit={openEdit}
              onDelete={handleDeleteProfile}
              onReorder={handleReorderProfiles}
              onExport={() => void handleExportConfig()}
              onImport={() => void handleImportConfig()}
            />
          </div>
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className="session-pane"
              data-active={
                activeId !== HOME_ID && t.sessionId === activeId ? 'true' : 'false'
              }
              style={{
                display: activeId !== HOME_ID && t.sessionId === activeId ? 'flex' : 'none'
              }}
            >
              {/* 每个会话页面支持全屏：鼠标到顶部浮出 全屏/退出全屏 按钮；
                  全屏状态由 App 全局控制（轮询校正），全屏时隐藏标题栏 */}
              <FullscreenView
                fsActive={appFullscreen}
                onEnter={enterFullscreen}
                onExit={exitFullscreen}
              >
                <SessionView tab={t} />
              </FullscreenView>
            </div>
          ))}
        </div>
      </div>

      {quickOpen && (
        <QuickConnectDialog
          profiles={profiles}
          onClose={() => setQuickOpen(false)}
          onOpen={openProfile}
          onEdit={openEdit}
          onDelete={handleDeleteProfile}
          onNew={openNew}
        />
      )}

      {dialogOpen && (
        <NewConnectionDialog
          editProfile={editProfile}
          initialProtocol={newProtocol}
          onClose={() => {
            setDialogOpen(false)
            setEditProfile(null)
          }}
          onSave={handleSaveProfile}
        />
      )}

      {gmOpen && (
        <GlobalMacroDialog
          onRun={(t, s) => void runGlobalMacro(t, s)}
          onClose={() => setGmOpen(false)}
        />
      )}
      {gmRunOpen && gmScript && (
        <GlobalMacroProgress
          targets={gmTargets}
          script={gmScript}
          status={gmStatus}
          onStop={stopGlobalMacro}
          onClose={() => setGmRunOpen(false)}
        />
      )}

      <UpdateBanner />
    </div>
  )
}
