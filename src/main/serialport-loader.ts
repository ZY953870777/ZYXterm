/**
 * serialport 原生模块的可选加载器
 *
 * 背景：串口依赖 serialport 原生模块（.node）。在 Docker/Linux 交叉打包出的
 * Windows 包中，该模块是 Linux ELF 格式，Windows 上无法加载
 * （报 "is not a valid Win32 application"）。若主进程在模块顶层静态
 * `import { SerialPort } from 'serialport'`，加载失败会直接导致整个主进程
 * 崩溃，SSH / VNC / RDP 也无法使用。
 *
 * 这里改为 try/catch 懒加载：加载失败时返回错误信息，调用方优雅降级，
 * 应用仍可正常启动；SSH / VNC / RDP 不受影响，串口功能提示不可用。
 */

/** serialport 端口实例的最小接口 */
export interface SerialPortInstance {
  isOpen: boolean
  open(cb: (err?: Error) => void): void
  write(data: string): void
  close(cb?: () => void): void
  on(event: string, listener: (...args: any[]) => void): void
}

interface SerialPortModule {
  SerialPort: new (options: Record<string, unknown>) => SerialPortInstance
  list: (options?: unknown) => Promise<unknown[]>
}

interface LoadResult {
  mod: SerialPortModule | null
  error: string | null
}

let cached: LoadResult | null = null

export function getSerialPortModule(): LoadResult {
  if (cached) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require('serialport') as SerialPortModule
    cached = { mod: m, error: null }
  } catch (e) {
    cached = { mod: null, error: (e as Error).message }
    console.warn('[serialport] 原生模块不可用（串口功能将被禁用）:', cached.error)
  }
  return cached
}
