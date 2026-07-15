import { test } from '@japa/runner'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import AuditPipeline, {
  type PipelineEmitter,
  type PipelineStoreRoute,
} from '../../src/core/pipeline.js'
import type { SuccessfulDeliveryNotifier } from '../../src/core/successful_delivery_notifier.js'
import type { AuditEvent, AuditStoreContract, OverflowStrategy } from '../../src/types.js'

interface FakeStore extends AuditStoreContract {
  failNext(count: number): void
}

function event(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
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
    ...overrides,
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
    routeStore?: (event: AuditEvent) => PipelineStoreRoute
    emitter?: PipelineEmitter
    notifier?: SuccessfulDeliveryNotifier
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
      notifier: overrides.notifier ?? { async notify() {} },
      deadLetterHandler: overrides.deadLetterHandler,
      routeStore: overrides.routeStore,
      emitter: overrides.emitter,
    }
  )
}

function createEmitter(): {
  emitter: PipelineEmitter
  emitted: { event: string; payload: unknown }[]
} {
  const emitted: { event: string; payload: unknown }[] = []
  return {
    emitted,
    emitter: {
      async emit(name, payload) {
        emitted.push({ event: String(name), payload })
      },
    },
  }
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

    assert.isTrue(await pipeline.enqueue(event('a')))
    assert.isFalse(await pipeline.enqueue(event('b')))
    await pipeline.shutdown()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].length, 1)
    assert.equal(pipeline.stats().dropped, 1)
  })

  test('block overflow flushes without stalling the event loop', async ({ assert }) => {
    const { store, writes } = createFakeStore()
    const pipeline = createPipeline(store, { capacity: 1, overflow: 'block' })
    const startedAt = Date.now()

    assert.isTrue(await pipeline.enqueue(event('a')))
    assert.isTrue(await pipeline.enqueue(event('b')))
    await pipeline.shutdown()

    assert.isBelow(Date.now() - startedAt, 100)
    assert.equal(pipeline.stats().dropped, 0)
    assert.deepEqual(
      writes.flat().map((queued) => queued.id),
      ['a', 'b']
    )
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

  test('file dead-letter handler writes NDJSON batches', async ({ assert }) => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-dlq-'))
    const dlqPath = join(directory, 'audit-dlq')

    try {
      const handler = AuditPipeline.createFileDeadLetterHandler(dlqPath)
      handler([event('a'), event('b')])

      const lines = readFileSync(dlqPath, 'utf8').trim().split('\n')
      assert.lengthOf(lines, 2)
      assert.equal(JSON.parse(lines[0]).id, 'a')
      assert.equal(JSON.parse(lines[1]).id, 'b')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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
        notifier: { async notify() {} },
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

  test('routes flush groups to their selected store', async ({ assert }) => {
    const primary = createFakeStore()
    const secondary = createFakeStore()
    const pipeline = createPipeline(primary.store, {
      maxBatchSize: 4,
      routeStore: (queued) =>
        queued.stream === 'secondary'
          ? { name: 'secondary', store: secondary.store }
          : { name: 'primary', store: primary.store },
    })

    pipeline.enqueue(event('a'))
    pipeline.enqueue(event('b'))
    pipeline.enqueue(event('c', { stream: 'secondary' }))
    await pipeline.shutdown()

    assert.deepEqual(
      primary.writes.flat().map((queued) => queued.id),
      ['a', 'b']
    )
    assert.deepEqual(
      secondary.writes.flat().map((queued) => queued.id),
      ['c']
    )
  })

  test('emits dropped and dead letter events', async ({ assert }) => {
    const { emitter, emitted } = createEmitter()
    const { store } = createFakeStore()
    const pipeline = createPipeline(store, { capacity: 1, overflow: 'dropNew', emitter })

    pipeline.enqueue(event('a'))
    pipeline.enqueue(event('b'))
    await pipeline.shutdown()

    assert.include(
      emitted.map((entry) => entry.event),
      'audit:dropped'
    )

    const deadLetterEmitter = createEmitter()
    const failing = createFakeStore()
    const deadLetterPipeline = createPipeline(failing.store, { emitter: deadLetterEmitter.emitter })
    failing.store.failNext(10)
    deadLetterPipeline.enqueue(event('c'))
    await deadLetterPipeline.shutdown()

    assert.include(
      deadLetterEmitter.emitted.map((entry) => entry.event),
      'audit:dead_letter'
    )
  })
  test('keeps shutdown open until an active delayed flush succeeds', async ({ assert }) => {
    const { promise: released, resolve } = Promise.withResolvers<void>()
    let writes = 0
    const store: AuditStoreContract = {
      async write(batch) {
        writes++
        await released
        return batch.map((queued, index) => ({
          ...queued,
          seq: index + 1,
          hash: `hash-${queued.id}`,
          prevHash: '0'.repeat(64),
        }))
      },
      async head() {
        return null
      },
      async *verify() {},
      async prune() {
        return { streams: [], totalPruned: 0, perEvent: {} }
      },
    }
    const pipeline = createPipeline(store, { maxBatchSize: 1 })

    await pipeline.enqueue(event('a'))
    const shutdown = pipeline.shutdown(1)
    let complete = false
    void shutdown.then(() => {
      complete = true
    })

    await sleep(10)
    assert.equal(writes, 1)
    assert.isFalse(complete)

    resolve()
    await shutdown
    assert.equal(pipeline.stats().written, 1)
  })

  test('applies block overflow as sustained asynchronous backpressure', async ({ assert }) => {
    const { promise: firstWrite, resolve } = Promise.withResolvers<void>()
    const writes: string[] = []
    let first = true
    const store: AuditStoreContract = {
      async write(batch) {
        writes.push(...batch.map((queued) => queued.id))
        if (first) {
          first = false
          await firstWrite
        }
        return batch.map((queued, index) => ({
          ...queued,
          seq: index + 1,
          hash: `hash-${queued.id}`,
          prevHash: '0'.repeat(64),
        }))
      },
      async head() {
        return null
      },
      async *verify() {},
      async prune() {
        return { streams: [], totalPruned: 0, perEvent: {} }
      },
    }
    const pipeline = createPipeline(store, {
      capacity: 1,
      maxBatchSize: 1,
      overflow: 'block',
    })

    await pipeline.enqueue(event('a'))
    const second = pipeline.enqueue(event('b'))
    let admitted = false
    void second.then((accepted) => {
      admitted = accepted
    })

    await sleep(10)
    assert.isFalse(admitted)
    assert.deepEqual(writes, ['a'])

    resolve()
    assert.isTrue(await second)
    await pipeline.shutdown()
    assert.deepEqual(writes, ['a', 'b'])
    assert.equal(pipeline.stats().dropped, 0)
  })
})
