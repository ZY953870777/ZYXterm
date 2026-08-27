import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ConnectionProfile,
  NewProfileInput,
  ProtocolType,
  SessionInfo
} from '@shared/types'
import SessionTabs from './components/SessionTabs'
import SessionView from './components/SessionView'
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

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string>(HOME_ID)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editProfile, setEditProfile] = useState<ConnectionProfile | null>(null)
  const [newProtocol, setNewProtocol] = useState<ProtocolType>('ssh')
  const [quickOpen, setQuickOpen] = useState(false)
  const [rdpAvailable, setRdpAvailable] = useState(true)

  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // 初始化：加载配置、检测 RDP、订阅状态事件
  useEffect(() => {
    window.api.listProfiles().then(setProfiles)
    window.api
      .detectRdp()
      .then((r) => setRdpAvailable(r.available))
      .catch(() => setRdpAvailable(false))

    const unsub = window.api.onConnectionStatus((info: SessionInfo) => {
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

  /** 接管一个已存在（或新分离）的会话，不重新发起连接 */
  const adoptSession = useCallback(
    async (profile: ConnectionProfile, sessionId: string) => {
      try {
        const info = (await window.api.listSessions()).find(
          (s) => s.sessionId === sessionId
        )
        const tab: Tab = {
          sessionId,
          name: profile.name,
          protocol: profile.protocol,
          status: info?.status ?? 'connecting',
          message: info?.message,
          wsEndpoint: info?.wsEndpoint,
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

  const openProfile = useCallback(async (profile: ConnectionProfile) => {
    try {
      const info = await window.api.createSession(profile)
      const tab: Tab = {
        sessionId: info.sessionId,
        name: info.name,
        protocol: info.protocol,
        status: info.status,
        message: info.message,
        wsEndpoint: info.wsEndpoint,
        profile
      }
      setTabs((prev) => [...prev, tab])
      setActiveId(info.sessionId)
    } catch (e) {
      alert(`连接失败: ${(e as Error).message}`)
    }
  }, [])

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

  const openEdit = useCallback((profile: ConnectionProfile) => {
    setNewProtocol(profile.protocol)
    setEditProfile(profile)
    setDialogOpen(true)
  }, [])

  const handleDeleteProfile = useCallback(async (id: string) => {
    if (!window.confirm('确定删除该连接配置？')) return
    await window.api.deleteProfile(id)
    setProfiles((prev) => prev.filter((p) => p.id !== id))
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
      setDialogOpen(false)
      setEditProfile(null)
      if (connectNow) await openProfile(profile)
    },
    [editProfile, openProfile]
  )

  return (
    <div className="app">
      <div className="main">
        <SessionTabs
          tabs={tabs}
          activeId={activeId}
          activeIsHome={activeId === HOME_ID}
          onSelect={setActiveId}
          onSelectHome={() => setActiveId(HOME_ID)}
          onClose={closeTab}
          onAdd={() => setQuickOpen(true)}
          onReconnect={reconnectTab}
          onEdit={(tab) => openEdit(tab.profile)}
          onReorder={reorderTab}
          onDetachTab={handleDetachTab}
          onAttachTab={handleAttachTab}
        />
        <div className="content">
          {/* 首页：独立 pane 覆盖显示；会话 pane 始终保持挂载（切走不销毁，
              避免 RDP/VNC canvas 缓冲重置导致切回黑屏）。用 block 保持
              ConnectionGrid 内部 grid 多列布局（flex 会压缩列宽成一列） */}
          <div className="home-pane" style={{ display: activeId === HOME_ID ? 'block' : 'none' }}>
            <ConnectionGrid
              profiles={profiles}
              rdpAvailable={rdpAvailable}
              onOpen={openProfile}
              onNew={openNew}
              onEdit={openEdit}
              onDelete={handleDeleteProfile}
            />
          </div>
          {tabs.map((t) => (
            <div
              key={t.sessionId}
              className="session-pane"
              style={{
                display: activeId !== HOME_ID && t.sessionId === activeId ? 'flex' : 'none'
              }}
            >
              <SessionView tab={t} />
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

      <UpdateBanner />
    </div>
  )
}
