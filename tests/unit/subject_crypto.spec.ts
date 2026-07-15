import { test } from '@japa/runner'
import { SubjectCrypto, MemorySubjectKeyStore } from '../../src/core/subject_crypto.js'
import { canonicalJson } from '../../src/core/canonical_json.js'
import type { AuditEvent } from '../../src/types.js'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

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

function defaultSubjectId(event: AuditEvent): string {
  return canonicalJson(['audit-subject', event.tenantId, event.actor.type, event.actor.id])
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
    await keyStore.delete(defaultSubjectId(baseEvent()))
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

    await keyStore.delete(defaultSubjectId(baseEvent()))

    assert.equal(
      JSON.stringify((encrypted.newValues as Record<string, unknown>).email),
      ciphertextBefore
    )
  })
  test('creates one consistent key for concurrent encryption', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })
    const events = await Promise.all(Array.from({ length: 20 }, () => crypto.encrypt(baseEvent())))

    for (const event of events) {
      const decrypted = await crypto.decrypt(event)
      assert.equal((decrypted.newValues as Record<string, unknown>).email, 'ada@example.com')
    }
  })

  test('uses tenant-scoped default subject identities', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })
    const tenantA = baseEvent({ tenantId: 'tenant-a' })
    const tenantB = baseEvent({ tenantId: 'tenant-b' })
    const encryptedA = await crypto.encrypt(tenantA)
    const encryptedB = await crypto.encrypt(tenantB)

    await keyStore.delete(defaultSubjectId(tenantA))

    const forgottenA = await crypto.decrypt(encryptedA)
    const restoredB = await crypto.decrypt(encryptedB)
    assert.equal(
      (forgottenA.newValues as Record<string, Record<string, unknown>>).email._forgotten,
      true
    )
    assert.equal((restoredB.newValues as Record<string, unknown>).email, 'ada@example.com')
  })
  test('binds subject key creation to the caller transaction', async ({ assert }) => {
    const keys = new Map<string, string>()
    const clients: unknown[] = []
    const keyStore = {
      async get(subjectId: string, client?: TransactionClientContract) {
        clients.push(client)
        return keys.get(subjectId) ?? null
      },
      async set(subjectId: string, key: string, client?: TransactionClientContract) {
        clients.push(client)
        if (!keys.has(subjectId)) {
          keys.set(subjectId, key)
        }
      },
      async delete(subjectId: string, client?: TransactionClientContract) {
        clients.push(client)
        keys.delete(subjectId)
      },
    }
    const transaction = {} as TransactionClientContract
    const crypto = new SubjectCrypto({ fields: ['email'], keyStore })

    await crypto.encrypt(baseEvent(), transaction)

    assert.isAbove(clients.length, 1)
    assert.isTrue(clients.every((client) => client === transaction))
  })
})
