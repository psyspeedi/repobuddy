import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const AUTH_TAG_LENGTH = 16

/**
 * AES-256-GCM encryption for storing secrets at rest (e.g. GitHub OAuth
 * refresh tokens in the DB). The key MUST be 32 bytes (64 hex chars), validated
 * by env.ts. Output format: base64(iv | authTag | ciphertext).
 */
export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex')
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`)
  }
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex')
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`)
  }
  const raw = Buffer.from(ciphertext, 'base64')
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short')
  }
  const iv = raw.subarray(0, IV_LENGTH)
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

/** Convenience: returns a fresh 32-byte hex key suitable for ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex')
}
