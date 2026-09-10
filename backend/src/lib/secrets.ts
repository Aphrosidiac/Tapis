import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

/// AES-256-GCM for secrets stored in app_settings. A plaintext API key in a
/// database dump is a published key. The key comes from CREDENTIAL_KEY, or is
/// generated once into a 0600 file beside the session directory.

const KEY_FILE = join(process.cwd(), '.credential-key')
let cachedKey: Buffer | null = null

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey
  const configured = process.env.CREDENTIAL_KEY
  if (configured) {
    cachedKey = createHash('sha256').update(configured).digest()
    return cachedKey
  }
  if (existsSync(KEY_FILE)) {
    const k = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex')
    if (k.length === 32) {
      cachedKey = k
      return k
    }
  }
  const key = randomBytes(32)
  writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 })
  try {
    chmodSync(KEY_FILE, 0o600)
  } catch {
    /* best effort */
  }
  cachedKey = key
  return key
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

export function decrypt(stored: string): string | null {
  try {
    const [v, ivHex, tagHex, dataHex] = stored.split(':')
    if (v !== 'v1') return null
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/// A four-character tail is enough to recognise a key without exposing it.
export function maskSecret(value: string): string {
  if (!value) return ''
  return `••••${value.slice(-4)}`
}
