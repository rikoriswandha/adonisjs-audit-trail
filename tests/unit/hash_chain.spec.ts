import { createHash } from 'node:crypto'
import { test } from '@japa/runner'
import {
  chainBatch,
  GENESIS,
  hashEntry,
  pickHashedFields,
  verifyChain,
} from '../../src/core/hash_chain.js'
import { canonicalJson } from '../../src/core/canonical_json.js'
import type { AuditEvent } from '../../src/types.js'

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '0192c6a0-0000-7fff-a000-000000000001',
    event: 'user.created',
    stream: 'default',
    auditableType: 'User',
    auditableId: '1',
    oldValues: null,
    newValues: { name: 'Ada' },
    metadata: null,
    actor: { type: 'user', id: '1', label: 'Ada Lovelace' },
    tenantId: null,
    requestId: 'req-1',
    correlationId: 'corr-1',
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    url: '/users',
    httpMethod: 'POST',
    tags: ['auth'],
    schemaVersion: '1',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

test.group('hash chain', () => {
  test('chainBatch with null head starts at genesis', ({ assert }) => {
    const batch = [
      auditEvent(),
      auditEvent({ event: 'user.updated' }),
      auditEvent({ event: 'user.deleted' }),
    ]
    const chained = chainBatch(batch, null)

    assert.equal(chained.length, 3)
    assert.equal(chained[0].seq, 1)
    assert.equal(chained[0].prevHash, GENESIS)
    assert.equal(chained[1].seq, 2)
    assert.equal(chained[1].prevHash, chained[0].hash)
    assert.equal(chained[2].seq, 3)
    assert.equal(chained[2].prevHash, chained[1].hash)

    for (const row of chained) {
      assert.match(row.hash, /^[a-f0-9]{64}$/)
    }
  })

  test('chainBatch continues from existing head', ({ assert }) => {
    const batch = [auditEvent(), auditEvent({ event: 'user.updated' })]
    const head = { seq: 10, hash: 'a'.repeat(64) }
    const chained = chainBatch(batch, head)

    assert.equal(chained[0].seq, 11)
    assert.equal(chained[0].prevHash, head.hash)
    assert.equal(chained[1].seq, 12)
    assert.equal(chained[1].prevHash, chained[0].hash)
  })

  test('mutating a row invalidates it and all successors', async ({ assert }) => {
    const batch = [
      auditEvent(),
      auditEvent({ event: 'user.updated' }),
      auditEvent({ event: 'user.deleted' }),
    ]
    const chained = chainBatch(batch, null)

    // Tamper with the second row
    chained[1].event = 'user.tampered'

    const reports = []
    for await (const report of verifyChain(iterate(chained))) {
      reports.push(report)
    }

    assert.equal(reports.length, 3)
    assert.isTrue(reports[0].valid)
    assert.isFalse(reports[1].valid)
    assert.isFalse(reports[2].valid)
    assert.equal(reports[1].firstInvalidSeq, 2)
  })

  test('hashEntry matches manual sha256 of canonical hashed fields', ({ assert }) => {
    const event = auditEvent()
    const entry = { ...event, seq: 1, prevHash: GENESIS }
    const expected = createHash('sha256')
      .update(canonicalJson(pickHashedFields(entry)))
      .digest('hex')

    assert.equal(hashEntry(entry), expected)
  })

  test('pickHashedFields excludes actor.label, tags, and transport fields', ({ assert }) => {
    const fields = pickHashedFields({ ...auditEvent(), seq: 1, prevHash: GENESIS })
    const keys = Object.keys(fields)

    assert.notProperty(fields, 'tags')
    assert.notProperty(fields, 'requestId')
    assert.notProperty(fields, 'correlationId')
    assert.notProperty(fields, 'ipAddress')
    assert.notProperty(fields, 'userAgent')
    assert.notProperty(fields, 'url')
    assert.notProperty(fields, 'httpMethod')

    assert.isFalse(keys.includes('actor.label'))
    assert.deepEqual(Object.keys(fields.actor as object), ['type', 'id'])

    assert.includeMembers(keys, [
      'id',
      'seq',
      'stream',
      'event',
      'auditableType',
      'auditableId',
      'oldValues',
      'newValues',
      'metadata',
      'actor',
      'tenantId',
      'schemaVersion',
      'createdAt',
      'prevHash',
    ])
  })
})
