/**
 * 串口自动化脚本解析器
 *
 * 语法（行级，大小写不敏感；行首 # 或空行忽略）：
 *   tx "内容"   —— 向串口发送内容；支持转义 \\n \\r \\t \\\\（引号可单可双，可省略；
 *                  单引号内可含双引号、双引号内可含单引号，无需转义）
 *   rx "内容"   —— 等待串口输出包含该内容（子串匹配）后才执行下一条
 *   sleep 5s    —— 延迟（单位 s/m/h，不区分大小写；缺省秒）
 *
 * 返回归一化步骤，供主进程执行。
 */
import { SerialMacroStep } from '@shared/types'

/** 把脚本文本解析为步骤列表；出错返回 { steps, error }（error 为行号+原因） */
export function parseMacroScript(text: string): {
  steps: SerialMacroStep[]
  error?: string
} {
  const steps: SerialMacroStep[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sp = line.search(/\s/)
    const head = sp < 0 ? line : line.slice(0, sp)
    const rest = sp < 0 ? '' : line.slice(sp).trim()
    const op = head.toLowerCase()
    if (op === 'tx' || op === 'rx') {
      const arg = parseQuotedArg(rest)
      if (arg === null) {
        return { steps, error: `第 ${i + 1} 行：参数引号未闭合` }
      }
      steps.push({ op, text: unescape(arg) })
    } else if (op === 'sleep') {
      const secs = parseSleep(rest)
      if (secs === null) {
        return { steps, error: `第 ${i + 1} 行：sleep 格式应为 数字 + s/m/h` }
      }
      steps.push({ op: 'sleep', secs })
    } else {
      return { steps, error: `第 ${i + 1} 行：未知指令 “${head}”（支持 tx / rx / sleep）` }
    }
  }
  if (steps.length === 0) return { steps, error: '脚本为空' }
  return { steps }
}

/** 解析参数引号：可省略；可单/双；开头是引号则要求结尾为同一引号 */
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

/** 把常见转义（\\n \\r \\t \\\\）还原为真实字符（未知转义保留原样） */
function unescape(s: string): string {
  return s.replace(/\\([nrt\\])/g, (_m, c: string) => {
    if (c === 'n') return '\n'
    if (c === 'r') return '\r'
    if (c === 't') return '\t'
    return '\\'
  })
}

/** 解析 sleep 参数：数字 + [s|m|h]（大小写不敏感，缺省 s） */
function parseSleep(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'h') return n * 3600
  if (unit === 'm') return n * 60
  if (unit === 'd') return n * 86400
  return n
}
