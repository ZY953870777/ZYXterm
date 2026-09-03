/**
 * sleep 时长解析 —— 串口自动化（macroParser）与联动自动化（globalMacroParser）
 * 共用同一实现，保证两处 sleep 语法完全一致：
 *   sleep <数字>[s|m|h]   单位可选，大小写不敏感；缺省单位为秒。
 *   例：sleep 10 == 10 秒；sleep 10s == 10 秒；sleep 2m == 120 秒；sleep 1h == 3600 秒
 * 返回换算后的秒数；无法解析返回 null。
 */
export function parseSleep(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'h') return n * 3600
  if (unit === 'm') return n * 60
  if (unit === 'd') return n * 86400
  return n
}
