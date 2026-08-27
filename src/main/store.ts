import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { ConnectionProfile } from '@shared/types'

/**
 * 连接配置的本地持久化（userData/connections.json）
 *
 * 密码字段（SSH password/passphrase、VNC password、RDP password）在写盘前用
 * Electron safeStorage 加密（Windows DPAPI / macOS Keychain / Linux libsecret），
 * 磁盘上只保存密文；内存与渲染进程始终使用明文。旧配置（明文、无 passwordEnc
 * 标记）首次保存时自动迁移为加密。
 */

function encryptSecret(plain: string): string | null {
  if (!plain) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(plain).toString('base64')
  } catch {
    return null
  }
}

function decryptSecret(enc: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

/** 加密 profile 中的密码字段（写盘前）。仅在 safeStorage 可用时加密，否则保持明文。 */
function encryptSecrets(profile: ConnectionProfile): void {
  if (profile.ssh) {
    const s = profile.ssh
    if (s.password) {
      const enc = encryptSecret(s.password)
      if (enc !== null) {
        s.password = enc
        s.passwordEnc = true
      }
    }
    if (s.passphrase) {
      const enc = encryptSecret(s.passphrase)
      if (enc !== null) {
        s.passphrase = enc
        s.passphraseEnc = true
      }
    }
  }
  if (profile.vnc && profile.vnc.password) {
    const enc = encryptSecret(profile.vnc.password)
    if (enc !== null) {
      profile.vnc.password = enc
      profile.vnc.passwordEnc = true
    }
  }
  if (profile.rdp && profile.rdp.password) {
    const enc = encryptSecret(profile.rdp.password)
    if (enc !== null) {
      profile.rdp.password = enc
      profile.rdp.passwordEnc = true
    }
  }
}

/** 解密 profile 中的密码字段（读盘后），返回明文给渲染进程/会话使用 */
function decryptSecrets(profile: ConnectionProfile): void {
  if (profile.ssh) {
    const s = profile.ssh
    if (s.passwordEnc) s.password = decryptSecret(s.password)
    if (s.passphraseEnc) s.passphrase = decryptSecret(s.passphrase)
  }
  if (profile.vnc && profile.vnc.passwordEnc) {
    profile.vnc.password = decryptSecret(profile.vnc.password)
  }
  if (profile.rdp && profile.rdp.passwordEnc) {
    profile.rdp.password = decryptSecret(profile.rdp.password)
  }
}

/** 深拷贝（子对象也拷贝），避免加密时污染内存中的明文 profile */
function deepCopyProfile(p: ConnectionProfile): ConnectionProfile {
  return {
    ...p,
    ssh: p.ssh ? { ...p.ssh } : undefined,
    serial: p.serial ? { ...p.serial } : undefined,
    vnc: p.vnc ? { ...p.vnc } : undefined,
    rdp: p.rdp ? { ...p.rdp } : undefined
  }
}

export class ProfileStore {
  private file(): string {
    return path.join(app.getPath('userData'), 'connections.json')
  }

  load(): ConnectionProfile[] {
    try {
      const raw = fs.readFileSync(this.file(), 'utf8')
      const parsed = JSON.parse(raw)
      const profiles = Array.isArray(parsed) ? (parsed as ConnectionProfile[]) : []
      // 磁盘为密文 → 解密后返回明文
      for (const p of profiles) decryptSecrets(p)
      return profiles
    } catch {
      return []
    }
  }

  save(profiles: ConnectionProfile[]): void {
    try {
      const dir = path.dirname(this.file())
      fs.mkdirSync(dir, { recursive: true })
      // 传入为明文 → 深拷贝后加密密码字段写盘
      const toWrite = profiles.map(deepCopyProfile)
      for (const p of toWrite) encryptSecrets(p)
      fs.writeFileSync(this.file(), JSON.stringify(toWrite, null, 2), 'utf8')
    } catch (e) {
      console.error('保存连接配置失败:', e)
    }
  }
}
