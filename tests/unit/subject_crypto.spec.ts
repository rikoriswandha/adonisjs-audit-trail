import { test } from '@japa/runner'
import { SubjectCrypto, MemorySubjectKeyStore } from '../../src/core/subject_crypto.js'
import type { AuditEvent } from '../../src/types.js'

function baseEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    event: 'user.created',
    stream: 'default',
    auditableType: null,
    auditableId: null,
    oldValues: null,
    newValues: { email: 'ada@example.com', name: 'Ada' },
    metadata: { notes: 'secret note' },
    actor: { type: 'user', id: 'user-1' },
    tenantId: null,
    requestId: null,
    correlationId: null,
    ipAddress: null,
    userAgent: null,
    url: null,
    httpMethod: null,
    tags: [],
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

test.group('SubjectCrypto', () => {
  test('encrypts configured fields and leaves others intact', async ({ assert }) => {
    const crypto = new SubjectCrypto({
      fields: ['email'],
      keyStore: new MemorySubjectKeyStore(),
    })

    const encrypted = await crypto.encrypt(baseEvent())

    const newValues = encrypted.newValues as Record<string, unknown>
    assert.isObject(newValues)
    assert.equal(newValues.name, 'Ada')
    assert.isObject(newValues.email)
    assert.equal((newValues.email as Record<string, unknown>)['_encrypted'], true)
    assert.isString((newValues.email as Record<string, unknown>).ciphertext)

    const metadata = encrypted.metadata as Record<string, unknown>
    assert.equal(metadata.notes, 'secret note')
  })

  test('decrypt restores original values', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })

    const encrypted = await crypto.encrypt(baseEvent())
    const decrypted = await crypto.decrypt(encrypted)

    assert.equal((decrypted.newValues as Record<string, unknown>).email, 'ada@example.com')
  })

  test('forget marks encrypted values as forgotten', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })

    const encrypted = await crypto.encrypt(baseEvent())
    await keyStore.delete('user-1')
    const decrypted = await crypto.decrypt(encrypted)

    const email = (decrypted.newValues as Record<string, unknown>).email
    assert.isObject(email)
    assert.equal((email as Record<string, unknown>)['_forgotten'], true)
  })

  test('ciphertext in stored event is unchanged after forget', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })

    const encrypted = await crypto.encrypt(baseEvent())
    const ciphertextBefore = JSON.stringify((encrypted.newValues as Record<string, unknown>).email)

    await keyStore.delete('user-1')

    assert.equal(
      JSON.stringify((encrypted.newValues as Record<string, unknown>).email),
      ciphertextBefore
    )
  })
})
