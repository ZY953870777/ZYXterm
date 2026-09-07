/**
 * VNC 按键映射的共用解析逻辑
 *
 * 同时供 VNCView（运行时匹配/发送）与 NewConnectionDialog（录制按键）使用，
 * 保证"录出来的字符串"和"运行时解析规则"完全一致。
 */
import type { VNCKeyMapping } from '@shared/types'

export interface ParsedCombo {
  mods: number[]
  key: number
}

export interface CompiledKeyMapping {
  mods: Set<string>
  key: number
  to: ParsedCombo
}

export interface CompiledMappings {
  keys: CompiledKeyMapping[]
  mouse: Map<number, ParsedCombo>
}

/** 旧配置没有 keyMappings 时的默认映射（与新建连接默认值一致） */
export const DEFAULT_KEY_MAPPINGS: VNCKeyMapping[] = [
  { from: 'mouse_back', to: 'ctrl+alt+minus' },
  { from: 'mouse_forward', to: 'ctrl+shift+minus' }
]

// X11 keysym 表（键名不区分大小写；单字符键直接按字符 keysym 处理）
const KEYSYM: Record<string, number> = {
  // 修饰键
  ctrl: 0xffe3, control: 0xffe3, control_l: 0xffe3, control_r: 0xffe4,
  shift: 0xffe1, shift_l: 0xffe1, shift_r: 0xffe2,
  alt: 0xffe9, alt_l: 0xffe9, alt_r: 0xffea,
  meta: 0xffeb, meta_l: 0xffe7, meta_r: 0xffe8,
  super: 0xffeb, super_l: 0xffeb, super_r: 0xffec, win: 0xffeb,
  hyper: 0xffed, hyper_l: 0xffed, hyper_r: 0xffee,
  caps_lock: 0xffe5, capslock: 0xffe5, shift_lock: 0xffe6,
  num_lock: 0xff7f, numlock: 0xff7f,
  scroll_lock: 0xff14, scrolllock: 0xff14,
  // 编辑 / 导航
  backspace: 0xff08, tab: 0xff09, linefeed: 0xff0a, clear: 0xff0b,
  enter: 0xff0d, return: 0xff0d,
  pause: 0xff13, print: 0xff61, sys_req: 0xff15, escape: 0xff1b, esc: 0xff1b,
  delete: 0xffff, del: 0xffff, insert: 0xff63, ins: 0xff63,
  home: 0xff50, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  page_up: 0xff55, pageup: 0xff55, prior: 0xff55,
  page_down: 0xff56, pagedown: 0xff56, next: 0xff56,
  end: 0xff57, begin: 0xff58,
  menu: 0xff67, help: 0xff6a, space: 0x20,
  // 符号（XK_* 名称；也可直接写单字符）
  exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, apostrophe: 0x27, quote: 0x27,
  parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b,
  comma: 0x2c, minus: 0x2d, period: 0x2e, slash: 0x2f,
  colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40,
  bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d,
  asciicircum: 0x5e, underscore: 0x5f, grave: 0x60, backquote: 0x60,
  braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  // 小键盘
  kp_space: 0xff80, kp_tab: 0xff89, kp_enter: 0xff8d,
  kp_f1: 0xff91, kp_f2: 0xff92, kp_f3: 0xff93, kp_f4: 0xff94,
  kp_home: 0xff95, kp_left: 0xff96, kp_up: 0xff97, kp_right: 0xff98,
  kp_down: 0xff99, kp_prior: 0xff9a, kp_page_up: 0xff9a,
  kp_next: 0xff9b, kp_page_down: 0xff9b, kp_end: 0xff9c,
  kp_begin: 0xff9d, kp_insert: 0xff9e, kp_delete: 0xff9f,
  kp_equal: 0xffbd, kp_multiply: 0xffaa, kp_add: 0xffab,
  kp_separator: 0xffac, kp_subtract: 0xffad, kp_decimal: 0xffae,
  kp_divide: 0xffaf,
  // 媒体 / 浏览器 / 系统键
  audio_mute: 0x1008ff12, mute: 0x1008ff12,
  audio_lower_volume: 0x1008ff11, volumedown: 0x1008ff11, voldown: 0x1008ff11,
  audio_raise_volume: 0x1008ff13, volumeup: 0x1008ff13, volup: 0x1008ff13,
  audio_play: 0x1008ff14, media_play: 0x1008ff14, play: 0x1008ff14,
  audio_stop: 0x1008ff15, media_stop: 0x1008ff15, stop: 0x1008ff15,
  audio_prev: 0x1008ff16, media_prev: 0x1008ff16, previous: 0x1008ff16,
  audio_next: 0x1008ff17, media_next: 0x1008ff17,
  audio_record: 0x1008ff1c, audio_pause: 0x1008ff31,
  home_page: 0x1008ff18, www: 0x1008ff2e, mail: 0x1008ff19,
  search: 0x1008ff1b, calculator: 0x1008ff1d,
  back: 0x1008ff26, forward: 0x1008ff27, refresh: 0x1008ff29,
  browser_stop: 0x1008ff28, power_off: 0x1008ff2a, sleep: 0x1008ff2f,
  wake_up: 0x1008ff2b, eject: 0x1008ff2c, screensaver: 0x1008ff2d,
  brightness_up: 0x1008ff02, brightness_down: 0x1008ff03
}

/** 需要 Shift 才能输入的单字符 → 基础键名（US 布局） */
const SHIFTED_CHARS: Record<string, string> = {
  '~': 'backquote',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: 'minus',
  '+': 'equal',
  '{': 'bracketleft',
  '}': 'bracketright',
  '|': 'backslash',
  ':': 'semicolon',
  '"': 'quote',
  '<': 'comma',
  '>': 'period',
  '?': 'slash'
}

/** 需要 Shift 的符号键名 → 基础键名（US 布局） */
const SHIFTED_NAMES: Record<string, string> = {
  plus: 'equal',
  underscore: 'minus',
  colon: 'semicolon',
  question: 'slash',
  asciitilde: 'backquote',
  exclam: '1',
  at: '2',
  numbersign: '3',
  dollar: '4',
  percent: '5',
  asciicircum: '6',
  ampersand: '7',
  asterisk: '8',
  parenleft: '9',
  parenright: '0',
  braceleft: 'bracketleft',
  braceright: 'bracketright',
  bar: 'backslash',
  quotedbl: 'quote',
  less: 'comma',
  greater: 'period'
}

/** 鼠标源名 → MouseEvent.button */
export const MOUSE_BUTTONS: Record<string, number> = {
  mouse_left: 0,
  mouse_middle: 1,
  mouse_right: 2,
  mouse_back: 3,
  mouse_forward: 4
}

/** MouseEvent.button → 鼠标源名 */
const BUTTON_TO_MOUSE: Record<number, string | undefined> = {
  0: 'mouse_left',
  1: 'mouse_middle',
  2: 'mouse_right',
  3: 'mouse_back',
  4: 'mouse_forward'
}

/** KeyboardEvent.code → 键名（供 resolveShortcutToken 解析） */
const CODE_TO_TOKEN: Record<string, string> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end',
  Insert: 'insert', Delete: 'delete', Backspace: 'backspace', Tab: 'tab',
  Enter: 'enter', NumpadEnter: 'kp_enter', Escape: 'escape', Space: 'space',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft',
  BracketRight: 'bracketright', Backslash: 'backslash', Semicolon: 'semicolon',
  Quote: 'quote', Comma: 'comma', Period: 'period', Slash: 'slash',
  Backquote: 'backquote', NumpadAdd: 'kp_add', NumpadSubtract: 'kp_subtract',
  NumpadMultiply: 'kp_multiply', NumpadDivide: 'kp_divide',
  NumpadDecimal: 'kp_decimal', NumpadEqual: 'kp_equal',
  NumpadComma: 'kp_separator',
  CapsLock: 'capslock', NumLock: 'numlock', ScrollLock: 'scrolllock',
  ShiftLeft: 'shift_l', ShiftRight: 'shift_r',
  ControlLeft: 'control_l', ControlRight: 'control_r',
  AltLeft: 'alt_l', AltRight: 'alt_r',
  MetaLeft: 'meta_l', MetaRight: 'meta_r',
  PrintScreen: 'print', Pause: 'pause', ContextMenu: 'menu',
  MediaPlayPause: 'audio_play', MediaStop: 'audio_stop',
  MediaTrackNext: 'audio_next', MediaTrackPrevious: 'audio_prev',
  AudioVolumeMute: 'audio_mute', AudioVolumeUp: 'volumeup',
  AudioVolumeDown: 'volumedown',
  BrowserBack: 'back', BrowserForward: 'forward', BrowserHome: 'home_page',
  BrowserRefresh: 'refresh', BrowserSearch: 'search',
  LaunchMail: 'mail', LaunchApp2: 'calculator',
  Power: 'power_off', Sleep: 'sleep'
}

/** KeyboardEvent.code → 键名（无法识别时返回 undefined） */
export function keyboardEventToken(e: KeyboardEvent): string | undefined {
  const code = e.code
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  const fkey = /^F([0-9]{1,2})$/.exec(code)
  if (fkey) return `f${fkey[1]}`
  const kp = /^Numpad([0-9])$/.exec(code)
  if (kp) return `kp_${kp[1]}`
  return CODE_TO_TOKEN[code]
}

/** keysym → 规范修饰键名（左/右修饰键视为同一种） */
export function modifierName(keysym: number): string | undefined {
  switch (keysym) {
    case 0xffe1:
    case 0xffe2:
      return 'shift'
    case 0xffe3:
    case 0xffe4:
      return 'ctrl'
    case 0xffe9:
    case 0xffea:
      return 'alt'
    case 0xffe7:
    case 0xffe8:
    case 0xffeb:
    case 0xffec:
    case 0xffed:
    case 0xffee:
      return 'meta'
    default:
      return undefined
  }
}

/** 修饰键键名（KeyboardEvent.code 解析结果）→ 规范修饰键名 */
export function modifierTokenName(token: string | undefined): string | undefined {
  switch (token) {
    case 'shift_l':
    case 'shift_r':
      return 'shift'
    case 'control_l':
    case 'control_r':
      return 'ctrl'
    case 'alt_l':
    case 'alt_r':
      return 'alt'
    case 'meta_l':
    case 'meta_r':
      return 'meta'
    default:
      return undefined
  }
}

/** 当前按下的修饰键集合（键盘/鼠标事件通用） */
export function eventModifiers(e: KeyboardEvent | MouseEvent): Set<string> {
  const mods = new Set<string>()
  if (e.ctrlKey) mods.add('ctrl')
  if (e.shiftKey) mods.add('shift')
  if (e.altKey) mods.add('alt')
  if (e.metaKey) mods.add('meta')
  return mods
}

export function sameMods(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const m of a) if (!b.has(m)) return false
  return true
}

/**
 * 键名 → X11 keysym。
 * - 单个字符直接取字符码（区分大小写：'A' 与 'a' 不同；非 Latin-1
 *   字符使用 X11 的 Unicode keysym 0x01000000 | codepoint）
 * - 多字符键名不区分大小写，支持 F1-F35、小键盘 kp_0..kp_9、
 *   以及 0x1234 / unicode:4e2d 形式的任意 keysym
 */
export function resolveShortcutToken(token: string): number | undefined {
  if ([...token].length === 1) {
    const cp = token.codePointAt(0)
    if (cp === undefined) return undefined
    if (cp >= 0x20 && cp <= 0xff) return cp
    return 0x01000000 + cp
  }
  const name = token.toLowerCase().replace(/[\s-]+/g, '_')
  const known = KEYSYM[name]
  if (known !== undefined) return known
  const fkey = /^f([1-9]|[12][0-9]|3[0-5])$/.exec(name)
  if (fkey) return 0xffbe + Number(fkey[1]) - 1
  const kp = /^kp_([0-9])$/.exec(name)
  if (kp) return 0xffb0 + Number(kp[1])
  if (/^0x[0-9a-f]+$/.test(name)) return parseInt(name.slice(2), 16)
  const uni = /^(?:unicode|u):([0-9a-f]+)$/.exec(name)
  if (uni) return 0x01000000 | parseInt(uni[1], 16)
  return undefined
}

/**
 * 解析 "ctrl+shift+left" 形式的快捷键。
 * spec 为 undefined 时用默认值；空字符串表示显式关闭映射。
 */
export function parseShortcut(
  spec: string | undefined,
  fallback: string
): ParsedCombo | null {
  const raw = (spec === undefined ? fallback : spec).trim()
  if (!raw) return null
  const parts = raw
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const key = resolveShortcutToken(parts[parts.length - 1])
  if (key === undefined) return null
  const mods: number[] = []
  for (const part of parts.slice(0, -1)) {
    const m = resolveShortcutToken(part)
    if (m === undefined) return null
    mods.push(m)
  }
  return { mods, key }
}

export function shortcutLastToken(spec: string | undefined): string {
  return (spec ?? '').split('+').pop()?.trim() ?? ''
}

/**
 * 把"Shift 后产生的字符"转换为 基础键 + Shift。
 * 例如 A → shift+a、? → shift+slash，便于和 KeyboardEvent 的物理键位匹配，
 * 也避免目标组合里重复按 Shift。
 */
export function withImpliedShift(
  combo: ParsedCombo,
  lastToken: string
): ParsedCombo {
  let key = combo.key
  let needShift = false
  if ([...lastToken].length === 1) {
    if (/^[A-Z]$/.test(lastToken)) {
      key += 0x20
      needShift = true
    } else if (SHIFTED_CHARS[lastToken]) {
      const base = resolveShortcutToken(SHIFTED_CHARS[lastToken])
      if (base !== undefined) {
        key = base
        needShift = true
      }
    }
  } else {
    const baseName = SHIFTED_NAMES[lastToken.toLowerCase()]
    if (baseName) {
      const base = resolveShortcutToken(baseName)
      if (base !== undefined) {
        key = base
        needShift = true
      }
    }
  }
  if (!needShift) return combo
  const hasShift = combo.mods.some((k) => modifierName(k) === 'shift')
  return {
    mods: hasShift ? combo.mods : [...combo.mods, 0xffe1],
    key
  }
}

/** 把用户填写的映射表编译成可快速匹配的结构 */
export function compileMappings(list: VNCKeyMapping[] | undefined): CompiledMappings {
  const keys: CompiledKeyMapping[] = []
  const mouse = new Map<number, ParsedCombo>()
  for (const item of list ?? []) {
    const from = (item?.from ?? '').trim()
    const parsedTo = parseShortcut(item?.to, '')
    if (!from || !parsedTo) continue
    const to = withImpliedShift(parsedTo, shortcutLastToken(item?.to))
    const mouseButton = MOUSE_BUTTONS[from.toLowerCase().replace(/\s+/g, '')]
    if (mouseButton !== undefined) {
      mouse.set(mouseButton, to)
      continue
    }
    const parsedFrom = parseShortcut(from, '')
    if (!parsedFrom) continue
    const src = withImpliedShift(parsedFrom, shortcutLastToken(from))
    const mods = new Set<string>()
    let ok = true
    for (const k of src.mods) {
      const name = modifierName(k)
      if (!name) {
        ok = false
        break
      }
      mods.add(name)
    }
    if (!ok) continue
    keys.push({ mods, key: src.key, to })
  }
  return { keys, mouse }
}

/** 键盘事件的规范映射串，如 "ctrl+shift+p"、"f12" */
export function keyboardEventToSpec(e: KeyboardEvent): string | null {
  if (e.isComposing) return null
  const token = keyboardEventToken(e)
  if (!token) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.shiftKey) mods.push('shift')
  if (e.altKey) mods.push('alt')
  if (e.metaKey) mods.push('meta')
  mods.push(token)
  return mods.join('+')
}

/** 鼠标事件的规范映射串，如 "mouse_back" */
export function mouseEventToSpec(e: MouseEvent): string | null {
  return BUTTON_TO_MOUSE[e.button] ?? null
}

/** 是否只是按下了修饰键（录制时需要继续等待主键） */
export function isModifierKeyboardEvent(e: KeyboardEvent): boolean {
  return modifierTokenName(keyboardEventToken(e)) !== undefined
}

/** 源输入（键盘或鼠标）→ 规范映射串 */
export function eventToSourceSpec(e: KeyboardEvent | MouseEvent): string | null {
  if ('code' in e) return keyboardEventToSpec(e as KeyboardEvent)
  return mouseEventToSpec(e as MouseEvent)
}

/** 目标输入（只能键盘）→ 规范映射串 */
export function eventToTargetSpec(e: KeyboardEvent): string | null {
  return keyboardEventToSpec(e)
}
