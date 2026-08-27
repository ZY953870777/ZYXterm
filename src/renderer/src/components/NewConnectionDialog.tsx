import { useEffect, useState } from 'react'
import {
  BAUD_RATES,
  ConnectionProfile,
  NewProfileInput,
  ProtocolType,
  RDP_RESOLUTIONS,
  SerialPortInfo,
  SSHProfile,
  SerialProfile,
  VNCProfile,
  VNCScaleMode,
  RDPProfile
} from '@shared/types'

interface Props {
  editProfile: ConnectionProfile | null
  /** 新建时预选的协议类型 */
  initialProtocol?: ProtocolType
  onClose: () => void
  onSave: (input: NewProfileInput, connectNow: boolean) => void
}

const PROTOCOLS: { key: ProtocolType; label: string }[] = [
  { key: 'ssh', label: 'SSH' },
  { key: 'serial', label: '串口' },
  { key: 'vnc', label: 'VNC' },
  { key: 'rdp', label: 'RDP' }
]

const DEFAULT_SSH: SSHProfile = {
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: ''
}

const DEFAULT_SERIAL: SerialProfile = {
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none'
}

const DEFAULT_VNC: VNCProfile = {
  host: '',
  port: 5900,
  password: '',
  viewOnly: false,
  scaleView: true,
  quality: 6,
  scaleMode: 'fill'
}

const DEFAULT_RDP: RDPProfile = {
  host: '',
  port: 3389,
  username: '',
  password: '',
  domain: '',
  resolution: '1280x800'
}

export default function NewConnectionDialog({
  editProfile,
  initialProtocol,
  onClose,
  onSave
}: Props) {
  const [protocol, setProtocol] = useState<ProtocolType>(
    editProfile?.protocol ?? initialProtocol ?? 'ssh'
  )
  const [name, setName] = useState(editProfile?.name ?? '')
  const [ssh, setSsh] = useState<SSHProfile>(editProfile?.ssh ?? DEFAULT_SSH)
  const [serial, setSerial] = useState<SerialProfile>(
    editProfile?.serial ?? DEFAULT_SERIAL
  )
  const [vnc, setVnc] = useState<VNCProfile>(editProfile?.vnc ?? DEFAULT_VNC)
  const [rdp, setRdp] = useState<RDPProfile>(editProfile?.rdp ?? DEFAULT_RDP)
  const [connectNow, setConnectNow] = useState(true)
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [error, setError] = useState('')

  const refreshPorts = async (): Promise<void> => {
    const list = await window.api.listSerialPorts()
    setPorts(list)
    if (list.length === 0) {
      setError('未检测到串口设备')
    } else {
      setError('')
    }
  }

  useEffect(() => {
    if (protocol === 'serial') refreshPorts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol])

  const pickFile = async (): Promise<void> => {
    const path = await window.api.selectFile()
    if (path) setSsh((prev) => ({ ...prev, privateKeyPath: path }))
  }

  const submit = (): void => {
    if (!name.trim()) {
      setError('请输入连接名称')
      return
    }
    if (protocol === 'ssh' && !ssh.host.trim()) {
      setError('请输入主机地址')
      return
    }
    if (protocol === 'serial' && !serial.path.trim()) {
      setError('请选择串口设备')
      return
    }
    if (protocol === 'vnc' && !vnc.host.trim()) {
      setError('请输入 VNC 主机地址')
      return
    }
    if (protocol === 'rdp' && !rdp.host.trim()) {
      setError('请输入 RDP 主机地址')
      return
    }
    onSave(
      {
        name: name.trim(),
        protocol,
        ssh: protocol === 'ssh' ? ssh : undefined,
        serial: protocol === 'serial' ? serial : undefined,
        vnc: protocol === 'vnc' ? vnc : undefined,
        rdp: protocol === 'rdp' ? rdp : undefined
      },
      connectNow
    )
  }

  const field = (
    label: string,
    control: React.ReactNode,
    full = false
  ): React.ReactNode => (
    <label className={`form-field${full ? ' full' : ''}`}>
      <span className="form-label">{label}</span>
      {control}
    </label>
  )

  return (
    <div className="dialog-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <div className="dialog-header">
          <h2>{editProfile ? '编辑连接' : '新建连接'}</h2>
          <button className="dialog-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="proto-tabs">
          {PROTOCOLS.map((p) => (
            <button
              key={p.key}
              className={`proto-tab ${protocol === p.key ? 'active' : ''}`}
              onClick={() => {
                setProtocol(p.key)
                setError('')
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="dialog-body">
          {field(
            '连接名称',
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产服务器 / 开发板"
            />,
            true
          )}

          {protocol === 'ssh' && (
            <>
              <div className="form-row">
                {field(
                  '主机',
                  <input
                    value={ssh.host}
                    onChange={(e) => setSsh({ ...ssh, host: e.target.value })}
                    placeholder="192.168.1.100"
                  />
                )}
                {field(
                  '端口',
                  <input
                    type="number"
                    value={ssh.port}
                    onChange={(e) =>
                      setSsh({ ...ssh, port: Number(e.target.value) || 22 })
                    }
                  />
                )}
              </div>
              <div className="form-row">
                {field(
                  '用户名',
                  <input
                    value={ssh.username}
                    onChange={(e) => setSsh({ ...ssh, username: e.target.value })}
                    placeholder="root"
                  />
                )}
                {field(
                  '认证方式',
                  <select
                    value={ssh.authType}
                    onChange={(e) =>
                      setSsh({
                        ...ssh,
                        authType: e.target.value as SSHProfile['authType']
                      })
                    }
                  >
                    <option value="password">密码</option>
                    <option value="privateKey">私钥</option>
                  </select>
                )}
              </div>
              {ssh.authType === 'password' ? (
                field(
                  '密码',
                  <input
                    type="password"
                    value={ssh.password}
                    onChange={(e) => setSsh({ ...ssh, password: e.target.value })}
                    placeholder="SSH 密码"
                  />,
                  true
                )
              ) : (
                <>
                  {field(
                    '私钥文件',
                    <div className="file-pick">
                      <input
                        readOnly
                        value={ssh.privateKeyPath}
                        placeholder="选择或输入私钥路径"
                        onChange={(e) =>
                          setSsh({ ...ssh, privateKeyPath: e.target.value })
                        }
                      />
                      <button type="button" onClick={pickFile}>
                        浏览…
                      </button>
                    </div>,
                    true
                  )}
                  {field(
                    '私钥口令 (可选)',
                    <input
                      type="password"
                      value={ssh.passphrase}
                      onChange={(e) =>
                        setSsh({ ...ssh, passphrase: e.target.value })
                      }
                    />,
                    true
                  )}
                </>
              )}
            </>
          )}

          {protocol === 'serial' && (
            <>
              {field(
                '串口设备',
                <div className="file-pick">
                  <select
                    value={serial.path}
                    onChange={(e) =>
                      setSerial({ ...serial, path: e.target.value })
                    }
                  >
                    <option value="">选择串口…</option>
                    {ports.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.path}
                        {p.manufacturer ? ` (${p.manufacturer})` : ''}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={refreshPorts}>
                    刷新
                  </button>
                </div>,
                true
              )}
              <div className="form-row">
                {field(
                  '波特率',
                  <select
                    value={serial.baudRate}
                    onChange={(e) =>
                      setSerial({ ...serial, baudRate: Number(e.target.value) })
                    }
                  >
                    {BAUD_RATES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                )}
                {field(
                  '数据位',
                  <select
                    value={serial.dataBits}
                    onChange={(e) =>
                      setSerial({
                        ...serial,
                        dataBits: Number(e.target.value) as SerialProfile['dataBits']
                      })
                    }
                  >
                    {[5, 6, 7, 8].map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="form-row">
                {field(
                  '停止位',
                  <select
                    value={serial.stopBits}
                    onChange={(e) =>
                      setSerial({
                        ...serial,
                        stopBits: Number(e.target.value) as SerialProfile['stopBits']
                      })
                    }
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                )}
                {field(
                  '校验位',
                  <select
                    value={serial.parity}
                    onChange={(e) =>
                      setSerial({
                        ...serial,
                        parity: e.target.value as SerialProfile['parity']
                      })
                    }
                  >
                    <option value="none">None</option>
                    <option value="even">Even</option>
                    <option value="odd">Odd</option>
                  </select>
                )}
              </div>
              {field(
                '流控',
                <select
                  value={serial.flowControl}
                  onChange={(e) =>
                    setSerial({
                      ...serial,
                      flowControl: e.target.value as SerialProfile['flowControl']
                    })
                  }
                >
                  <option value="none">无</option>
                  <option value="hardware">硬件 (RTS/CTS)</option>
                  <option value="software">软件 (XON/XOFF)</option>
                </select>,
                true
              )}
            </>
          )}

          {protocol === 'vnc' && (
            <>
              <div className="form-row">
                {field(
                  '主机',
                  <input
                    value={vnc.host}
                    onChange={(e) => setVnc({ ...vnc, host: e.target.value })}
                    placeholder="192.168.1.100"
                  />
                )}
                {field(
                  '端口',
                  <input
                    type="number"
                    value={vnc.port}
                    onChange={(e) =>
                      setVnc({ ...vnc, port: Number(e.target.value) || 5900 })
                    }
                  />
                )}
              </div>
              {field(
                '密码 (可选)',
                <input
                  type="password"
                  value={vnc.password}
                  onChange={(e) => setVnc({ ...vnc, password: e.target.value })}
                />,
                true
              )}
              <div className="form-row">
                {field(
                  '画质',
                  <input
                    type="range"
                    min={0}
                    max={9}
                    value={vnc.quality}
                    onChange={(e) =>
                      setVnc({ ...vnc, quality: Number(e.target.value) })
                    }
                  />
                )}
                {field(
                  '缩放方式',
                  <select
                    value={vnc.scaleMode ?? (vnc.scaleView ? 'fit' : 'none')}
                    onChange={(e) =>
                      setVnc({
                        ...vnc,
                        scaleMode: e.target.value as VNCScaleMode
                      })
                    }
                  >
                    <option value="none">不缩放（原始尺寸）</option>
                    <option value="fit">等比适配（完整显示）</option>
                    <option value="fill">拉伸铺满容器</option>
                  </select>
                )}
                <label className="form-field checkbox-field">
                  <input
                    type="checkbox"
                    checked={vnc.viewOnly}
                    onChange={(e) => setVnc({ ...vnc, viewOnly: e.target.checked })}
                  />
                  只读模式
                </label>
              </div>
            </>
          )}

          {protocol === 'rdp' && (
            <>
              <div className="form-row">
                {field(
                  '主机',
                  <input
                    value={rdp.host}
                    onChange={(e) => setRdp({ ...rdp, host: e.target.value })}
                    placeholder="192.168.1.100"
                  />
                )}
                {field(
                  '端口',
                  <input
                    type="number"
                    value={rdp.port}
                    onChange={(e) =>
                      setRdp({ ...rdp, port: Number(e.target.value) || 3389 })
                    }
                  />
                )}
              </div>
              <div className="form-row">
                {field(
                  '用户名',
                  <input
                    value={rdp.username}
                    onChange={(e) => setRdp({ ...rdp, username: e.target.value })}
                  />
                )}
                {field(
                  '域 (可选)',
                  <input
                    value={rdp.domain}
                    onChange={(e) => setRdp({ ...rdp, domain: e.target.value })}
                  />
                )}
              </div>
              {field(
                '密码',
                <input
                  type="password"
                  value={rdp.password}
                  onChange={(e) => setRdp({ ...rdp, password: e.target.value })}
                />,
                true
              )}
              {field(
                '分辨率',
                <select
                  value={rdp.resolution}
                  onChange={(e) => setRdp({ ...rdp, resolution: e.target.value })}
                >
                  {RDP_RESOLUTIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>,
                true
              )}
            </>
          )}
        </div>

        <div className="dialog-footer">
          {error && <span className="form-error">{error}</span>}
          <label className="connect-now">
            <input
              type="checkbox"
              checked={connectNow}
              onChange={(e) => setConnectNow(e.target.checked)}
            />
            保存后立即连接
          </label>
          <button className="btn-cancel" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit}>
            {editProfile ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
