/**
 * 跨会话（多 SSH/串口）联动脚本解析器
 *
 * 语法（行级，大小写不敏感；# 注释）：
 *   TX<ID> "内容"   —— 向会话 ID 发送（支持 \\n \\r \\t 转义；引号可省/可单双）
 *   RX<ID> "内容"   —— 等待会话 ID 输出包含该子串后再继续
 *   sleep 10        —— 延时；缺省单位秒，支持 10s / 2m / 1h（与串口自动化一致）
 * ID 即参与会话列表中的次序（0..n-1）；TX/RX 省略 ID 时沿用上一个目标（默认 0）。
 */
import { GlobalMacroStep } from '@shared/types'
import { parseSleep } from './sleepUnits'

export function parseGlobalMacro(text: string): {
  steps: GlobalMacroStep[]
  error?: string
} {
  const steps: GlobalMacroStep[] = []
  const lines = text.split(/\r?\n/)
  let lastTarget = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue

    if (/^(tx|rx)/i.test(line)) {
      const m = line.match(/^(tx|rx)(\d*)\s*(.*)$/i)
      if (!m) return { steps, error: `第 ${i + 1} 行：无法解析 TX/RX` }
      const argRaw = m[3].trim()
      const target = m[2] !== '' ? Number(m[2]) : lastTarget
      const arg = parseQuotedArg(argRaw)
      if (arg === null) return { steps, error: `第 ${i + 1} 行：参数引号未闭合` }
      lastTarget = target
      steps.push({ op: m[1].toLowerCase() as 'tx' | 'rx', target, text: unescape(arg) })
    } else if (/^sleep/i.test(line)) {
      const rest = line.replace(/^sleep/i, '').trim()
      const secs = parseSleep(rest)
      if (secs === null) return { steps, error: `第 ${i + 1} 行：sleep 应为 数字 + s/m/h` }
      steps.push({ op: 'sleep', target: -1, secs })
    } else {
      return { steps, error: `第 ${i + 1} 行：未知指令（支持 TX/RX/sleep）` }
    }
  }
  if (steps.length === 0) return { steps, error: '脚本为空' }
  return { steps }
}

function parseQuotedArg(s: string): string | null {
  const t = s.trim()
  if (t.length === 0) return ''
  const c0 = t[0]
  if (c0 === '"' || c0 === "'") {
    if (t.length < 2 || t[t.length - 1] !== c0) return null
    return t.slice(1, -1)
  }
  return t
}

function unescape(s: string): string {
  return s.replace(/\\([nrt\\])/g, (_m, c: string) => {
    if (c === 'n') return '\n'
    if (c === 'r') return '\r'
    if (c === 't') return '\t'
    return '\\'
  })
}

