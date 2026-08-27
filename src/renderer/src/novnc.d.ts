/**
 * @novnc/novnc 的类型声明
 * novnc 包仅导出 ./core/rfb.js（ESM，无自带类型），这里补充最小声明。
 */
declare module '@novnc/novnc' {
  export interface RFBOptions {
    /** 共享会话（默认 true） */
    shared?: boolean
    /** 认证凭据 */
    credentials?: Record<string, string>
    /** WebSocket 子协议，设置后走 websockify 握手 */
    wsProtocols?: string[] | null
    /** 只读模式 */
    viewOnly?: boolean
    /** 画质 0-9 */
    qualityLevel?: number
    /** 压缩 0-9 */
    compressionLevel?: number
    /** 自动调整会话大小以匹配窗口 */
    resizeSession?: boolean
  }

  export default class RFB {
    constructor(
      target: HTMLDivElement | HTMLElement,
      url: string,
      options?: RFBOptions
    )
    /** 是否在本地缩放画面以适配容器（novnc 1.7+ 的属性名） */
    scaleViewport: boolean
    viewOnly: boolean
    connected: boolean
    /** 向服务器发送剪贴板文本（客户端 → 服务器） */
    clipboardPasteFrom(text: string): void
    disconnect(): void
    sendCredentials(credentials: Record<string, string>): void
    addEventListener(type: string, listener: (e: CustomEvent) => void): void
    removeEventListener(type: string, listener: (e: CustomEvent) => void): void
  }
}
