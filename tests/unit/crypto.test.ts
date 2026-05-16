import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, generateEncryptionKey } from '../../server/lib/crypto'

describe('crypto', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('round-trips short string', () => {
    const plaintext = 'gho_test_token_abc123'
    const ciphertext = encrypt(plaintext, key)
    expect(ciphertext).not.toBe(plaintext)
    expect(decrypt(ciphertext, key)).toBe(plaintext)
  })

  it('round-trips utf-8 with multibyte chars', () => {
    const plaintext = 'токен 🔑 with spaces'
    expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext)
  })

  it('produces different ciphertexts for identical input (random IV)', () => {
    const a = encrypt('same', key)
    const b = encrypt('same', key)
    expect(a).not.toBe(b)
    expect(decrypt(a, key)).toBe('same')
    expect(decrypt(b, key)).toBe('same')
  })

  it('fails decryption with wrong key', () => {
    const ciphertext = encrypt('secret', key)
    const wrongKey =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    expect(() => decrypt(ciphertext, wrongKey)).toThrow()
  })

  it('fails decryption on tampered ciphertext (GCM auth tag check)', () => {
    const ciphertext = encrypt('secret', key)
    const tampered = ciphertext.slice(0, -4) + 'AAAA'
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('rejects malformed key length', () => {
    expect(() => encrypt('x', 'shortkey')).toThrow(/32 bytes/)
  })

  it('generateEncryptionKey returns valid 64-hex string', () => {
    const k = generateEncryptionKey()
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(() => encrypt('ok', k)).not.toThrow()
  })
})
