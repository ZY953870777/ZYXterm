import { Tab } from '../App'
import TerminalView from './TerminalView'
import VNCView from './VNCView'
import RDPView2 from './RDPView2'

interface Props {
  tab: Tab
}

/** 根据协议分发到对应视图 */
export default function SessionView({ tab }: Props) {
  switch (tab.protocol) {
    case 'ssh':
      return <TerminalView sessionId={tab.sessionId} protocol={tab.protocol} status={tab.status} />
    case 'serial':
      return <TerminalView sessionId={tab.sessionId} protocol={tab.protocol} status={tab.status} />
    case 'vnc':
      return <VNCView tab={tab} />
    case 'rdp':
      return <RDPView2 tab={tab} />
    default:
      return <div className="welcome">不支持的协议</div>
  }
}
