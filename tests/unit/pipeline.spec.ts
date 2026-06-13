import { test } from '@japa/runner'
import AuditPipeline from '../../src/core/pipeline.js'
import type { AuditEvent, AuditStoreContract, OverflowStrategy } from '../../src/types.js'

interface FakeStore extends AuditStoreContract {
  failNext(count: number): void
}

function event(id: string): AuditEvent {
  return {
    id,
    event: 'test',
    stream: 'default',
    auditableType: null,
    auditableId: null,
    oldValues: null,
    newValues: null,
    metadata: null,
    actor: { type: 'system', id: null },
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
  }
}

function createFakeStore(): {
  store: FakeStore
  writes: AuditEvent[][]
} {
  const writes: AuditEvent[][] = []
  let failures = 0

  const store: FakeStore = {
    async write(batch) {
      writes.push(batch)
      if (failures > 0) {
        failures--
        throw new Error('write failed')
      }
      return batch.map((e) => ({
        ...e,
        seq: writes.length * 100,
        hash: `hash-${e.id}`,
        prevHash: 'prev',
      }))
    },
    async head() {
      return null
    },
    async *verify() {},
    async prune() {
      return { streams: [], totalPruned: 0, perEvent: {} }
    },
    failNext(count: number) {
      failures = count
    },
  }

  return { store, writes }
}

function createPipeline(
  store: AuditStoreContract,
  overrides: {
    maxBatchSize?: number
    flushIntervalMs?: number
    capacity?: number
    overflow?: OverflowStrategy
    deadLetterHandler?: (events: AuditEvent[]) => void
  } = {}
) {
  return new AuditPipeline(
    {
      maxBatchSize: overrides.maxBatchSize ?? 10,
      flushIntervalMs: overrides.flushIntervalMs ?? 60_000,
      capacity: overrides.capacity ?? 10,
      overflow: overrides.overflow ?? 'dropOldest',
      retryBaseDelayMs: 1,
    },
    {
      store,
      deadLetterHandler: overrides.deadLetterHandler,
    }
  )
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

test.group('AuditPipeline', () => {
  test('batches events up to maxBatchSize', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store, { maxBatchSize: 3 })

    pipeline.enqueue(event('a'))
    pipeline.enqueue(event('b'))
    assert.equal(writes.length, 0)

    pipeline.enqueue(event('c'))
    await sleep(10)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].length, 3)
  })

  test('flushes on interval', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store, { flushIntervalMs: 20 })

    pipeline.start()
    pipeline.enqueue(event('a'))
    assert.equal(writes.length, 0)

    await sleep(40)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].length, 1)
  })

  test('dropOldest overflow removes oldest event', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store, { capacity: 2 })

    pipeline.enqueue(event('a'))
    pipeline.enqueue(event('b'))
    pipeline.enqueue(event('c'))

    await pipeline.shutdown()
    assert.equal(writes.length, 1)
    assert.deepEqual(
      writes[0].map((e) => e.id),
      ['b', 'c']
    )
    assert.equal(pipeline.stats().dropped, 1)
  })

  test('dropNew overflow returns false', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store, { capacity: 1, overflow: 'dropNew' })

    assert.isTrue(pipeline.enqueue(event('a')))
    assert.isFalse(pipeline.enqueue(event('b')))
    await pipeline.shutdown()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].length, 1)
    assert.equal(pipeline.stats().dropped, 1)
  })

  test('retries failed writes and succeeds', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store)

    store.failNext(2)
    pipeline.enqueue(event('a'))
    await pipeline.shutdown()

    assert.isAtLeast(writes.length, 3)
    assert.equal(pipeline.stats().written, 1)
    assert.isAtLeast(pipeline.stats().retried, 2)
  })

  test('dead-letters after retry exhaustion', async ({ assert }) => {
    const deadLetters: AuditEvent[][] = []
    const { store } = createFakeStore()
    const pipeline = createPipeline(store, {
      deadLetterHandler: (batch) => deadLetters.push(batch),
    })

    store.failNext(10)
    pipeline.enqueue(event('a'))
    await pipeline.shutdown()

    assert.equal(deadLetters.length, 1)
    assert.equal(deadLetters[0][0].id, 'a')
    assert.equal(pipeline.stats().deadLettered, 1)
  })

  test('shutdown drains pending events', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store)

    pipeline.enqueue(event('a'))
    pipeline.enqueue(event('b'))
    await pipeline.shutdown()

    assert.equal(writes.length, 1)
    assert.equal(writes[0].length, 2)
  })

  test('requestCoupledFlush resolves after flush', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store)

    const evt = event('a')
    pipeline.enqueue(evt)
    await pipeline.requestCoupledFlush([evt.id])

    assert.equal(writes.length, 1)
  })

  test('requestCoupledFlush times out', async ({ assert }) => {
    const { store } = createFakeStore()
    const pipeline = createPipeline(store)

    store.failNext(10)
    const evt = event('a')
    pipeline.enqueue(evt)

    await assert.rejects(() => pipeline.requestCoupledFlush([evt.id], 50), /timed out/i)
  })

  test('redactor transforms values', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = new AuditPipeline(
      { maxBatchSize: 1, flushIntervalMs: 60_000, capacity: 10, overflow: 'dropOldest' },
      {
        store,
        redactor: {
          redact(values) {
            return { ...values, password: '[REDACTED]' }
          },
        },
      }
    )

    const evt = event('a')
    evt.newValues = { password: 'secret' }
    pipeline.enqueue(evt)
    await pipeline.shutdown()

    assert.equal(writes[0][0].newValues?.password, '[REDACTED]')
  })
})
