#!/usr/bin/env node
/**
 * 验证连接配置密码的加密存储逻辑（ProfileStore 的加解密语义）：
 * - 模式 A：当前环境真实 safeStorage（Linux 无 keyring 时不可用 → 回退明文）
 * - 模式 B：mock safeStorage 可用（模拟 Windows DPAPI）→ 加密写盘 + 解密读回
 * 断言：safeStorage 可用时磁盘不含明文；两种模式读回密码均与明文一致。
 * 运行：env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/test-store-encrypt.cjs
 */
const { app, safeStorage } = require('electron')

// 与 src/main/store.ts 保持一致的最小实现，验证语义正确
function encryptSecret(plain) {
  if (!plain) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(plain).toString('base64')
  } catch {
    return null
  }
}
function decryptSecret(enc) {
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

// 模拟 Windows DPAPI 可用：覆盖 safeStorage 方法，验证「加密分支」
function mockAvailable() {
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.encryptString = (s) => Buffer.from('ENC::' + s + '::')
  safeStorage.decryptString = (b) => {
    const s = b.toString()
    return s.startsWith('ENC::') && s.endsWith('::') ? s.slice(5, -2) : ''
  }
  console.log('[test] 已 mock safeStorage 为可用（模拟 Windows DPAPI）')
}

function run(plain) {
  const profile = {
    id: '1',
    name: '测试',
    protocol: 'rdp',
    rdp: { host: '10.0.0.1', port: 3389, username: 'u', password: plain, domain: 'd' },
    createdAt: 0
  }

  // —— save：深拷贝 + 加密 ——
  const toWrite = JSON.parse(JSON.stringify(profile))
  const enc = encryptSecret(toWrite.rdp.password)
  if (enc !== null) {
    toWrite.rdp.password = enc
    toWrite.rdp.passwordEnc = true
    console.log('[test] 磁盘密码(加密):', toWrite.rdp.password.slice(0, 20) + '…(base64/密文)')
  } else {
    console.log('[test] 磁盘密码(未加密，明文):', toWrite.rdp.password)
  }

  // 断言：safeStorage 可用时磁盘上不应出现明文密码
  const leakedOnDisk = safeStorage.isEncryptionAvailable() && JSON.stringify(toWrite).includes(plain)
  console.log('[test] 磁盘含明文密码:', leakedOnDisk, leakedOnDisk ? '❌' : '✅')

  // —— load：解密读回 ——
  const fromDisk = JSON.parse(JSON.stringify(toWrite))
  if (fromDisk.rdp.passwordEnc) {
    fromDisk.rdp.password = decryptSecret(fromDisk.rdp.password)
  }
  const roundtrip = fromDisk.rdp.password === plain
  console.log('[test] 读回密码一致:', roundtrip, roundtrip ? '✅' : '❌')
  console.log('[test] 读回密码:', fromDisk.rdp.password)
  return roundtrip && !leakedOnDisk
}

app.whenReady().then(() => {
  const plain = 'P@ssw0rd-测试-123'
  let ok = true

  const available = safeStorage.isEncryptionAvailable()
  console.log('[test] safeStorage available:', available)
  if (available) console.log('[test] backend:', safeStorage.getSelectedStorageBackend())

  console.log('--- 模式 A：当前环境（真实 safeStorage） ---')
  ok = run(plain) && ok

  console.log('--- 模式 B：模拟 Windows DPAPI 可用（加密分支） ---')
  mockAvailable()
  ok = run(plain) && ok

  console.log('[test] 结果:', ok ? '全部通过 ✅' : '存在失败 ❌')
  app.exit(ok ? 0 : 1)
})
