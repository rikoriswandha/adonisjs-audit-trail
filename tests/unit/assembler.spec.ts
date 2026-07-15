import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { assembleEvent } from '../../src/core/assembler.js'
import type { AuditContextStore } from '../../src/audit_context.js'
import type { AuditEvent } from '../../src/types.js'

test.group('assembleEvent', () => {
  test('generates a UUIDv7 id and ISO timestamp', async ({ assert }) => {
    const event = await assembleEvent(
      { event: 'user.created' },
      {},
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )

    assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.match(event.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('resolves stream by global, tenant, or function', async ({ assert }) => {
    const globalEvent = await assembleEvent(
      { event: 'x' },
      {},
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )
    assert.equal(globalEvent.stream, 'default')

    const tenantEvent = await assembleEvent(
      { event: 'x' },
      { tenantId: 'acme' },
      { payloadMaxBytes: 32_768, streamBy: 'tenant' }
    )
    assert.equal(tenantEvent.stream, 'acme')

    const customEvent = await assembleEvent(
      { event: 'x' },
      {},
      { payloadMaxBytes: 32_768, streamBy: () => 'custom' }
    )
    assert.equal(customEvent.stream, 'custom')
  })

  test('resolves actor from context', async ({ assert }) => {
    const systemEvent = await assembleEvent(
      { event: 'x' },
      {},
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )
    assert.deepEqual(systemEvent.actor, { type: 'system', id: null })

    const actorEvent = await assembleEvent(
      { event: 'x' },
      { actor: { type: 'user', id: '42' } },
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )
    assert.deepEqual(actorEvent.actor, { type: 'user', id: '42' })

    const lazyEvent = await assembleEvent(
      { event: 'x' },
      { actor: async () => ({ type: 'job', id: '7' }) },
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )
    assert.deepEqual(lazyEvent.actor, { type: 'job', id: '7' })
  })

  test('falls back to cli actor in console environment', async ({ assert }) => {
    const event = await assembleEvent(
      { event: 'x' },
      {},
      { payloadMaxBytes: 32_768, streamBy: 'global', environment: 'console' }
    )
    assert.deepEqual(event.actor, { type: 'cli', id: null })
  })

  test('falls back to system actor when lazy resolver returns null', async ({ assert }) => {
    const systemEvent = await assembleEvent(
      { event: 'x' },
      { actor: async () => null },
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )
    assert.deepEqual(systemEvent.actor, { type: 'system', id: null })

    const consoleEvent = await assembleEvent(
      { event: 'x' },
      { actor: async () => null },
      { payloadMaxBytes: 32_768, streamBy: 'global', environment: 'console' }
    )
    assert.deepEqual(consoleEvent.actor, { type: 'cli', id: null })
  })

  test('maps transport fields from context', async ({ assert }) => {
    const ctx: AuditContextStore = {
      requestId: 'req-1',
      correlationId: 'corr-1',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      url: '/posts',
      httpMethod: 'POST',
    }

    const event = await assembleEvent({ event: 'x' }, ctx, {
      payloadMaxBytes: 32_768,
      streamBy: 'global',
    })

    assert.equal(event.requestId, 'req-1')
    assert.equal(event.correlationId, 'corr-1')
    assert.equal(event.ipAddress, '10.0.0.1')
    assert.equal(event.url, '/posts')
    assert.equal(event.httpMethod, 'POST')
  })

  test('truncates oversized newValues and records a sha256', async ({ assert }) => {
    const bigValue = 'x'.repeat(100)
    const event = await assembleEvent(
      { event: 'x', newValues: { body: bigValue } },
      {},
      { payloadMaxBytes: 10, streamBy: 'global' }
    )

    const values = event.newValues as Record<string, unknown>
    assert.isTrue(values._truncated)
    assert.isDefined(values._sha256)
    assert.match(values._sha256 as string, /^[a-f0-9]{64}$/)
  })

  test('truncates oversized oldValues and metadata', async ({ assert }) => {
    const bigValue = 'x'.repeat(100)
    const event = await assembleEvent(
      {
        event: 'x',
        oldValues: { before: bigValue },
        metadata: { note: bigValue },
      },
      {},
      { payloadMaxBytes: 10, streamBy: 'global' }
    )

    const old = event.oldValues as Record<string, unknown>
    assert.isTrue(old._truncated)
    assert.isDefined(old._sha256)
    assert.match(old._sha256 as string, /^[a-f0-9]{64}$/)

    const meta = event.metadata as Record<string, unknown>
    assert.isTrue(meta._truncated)
    assert.isDefined(meta._sha256)
    assert.match(meta._sha256 as string, /^[a-f0-9]{64}$/)
  })

  test('applies schema version and tags', async ({ assert }) => {
    const event = await assembleEvent(
      { event: 'x', tags: ['a', 'b'] },
      {},
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )

    assert.equal(event.schemaVersion, '1')
    assert.deepEqual(event.tags, ['a', 'b'])
  })

  test('passes event shape to custom streamBy function', async ({ assert }) => {
    let captured: AuditEvent | undefined
    const streamBy = (event: AuditEvent) => {
      captured = event
      return `stream-${event.event}`
    }

    await assembleEvent(
      { event: 'order.placed', auditableType: 'Order', auditableId: '99' },
      { tenantId: 'acme' },
      { payloadMaxBytes: 32_768, streamBy }
    )

    assert.equal(captured!.event, 'order.placed')
    assert.equal(captured!.auditableType, 'Order')
    assert.equal(captured!.auditableId, '99')
    assert.equal(captured!.tenantId, 'acme')
  })
  test('strips query strings from captured URLs', async ({ assert }) => {
    const event = await assembleEvent(
      { event: 'post.read' },
      { url: '/posts/1?access_token=secret' },
      { payloadMaxBytes: 32_768, streamBy: 'global' }
    )

    assert.equal(event.url, '/posts/1')
  })

  test('rejects a missing or malformed tenant in tenant stream mode', async ({ assert }) => {
    await assert.rejects(
      () => assembleEvent({ event: 'x' }, {}, { payloadMaxBytes: 32_768, streamBy: 'tenant' }),
      /requires a tenant ID/
    )
    await assert.rejects(
      () =>
        assembleEvent(
          { event: 'x' },
          { tenantId: ' acme ' },
          { payloadMaxBytes: 32_768, streamBy: 'tenant' }
        ),
      /non-empty, trimmed strings/
    )
  })

  test('redacts and encrypts every payload before enforcing payload size', async ({ assert }) => {
    const encryptedValue = 'ciphertext'.repeat(20)
    const observedPayloads: AuditEvent[] = []
    const event = await assembleEvent(
      {
        event: 'private.changed',
        oldValues: { secret: 'old-secret' },
        newValues: { secret: 'new-secret' },
        metadata: { secret: 'metadata-secret' },
      },
      {},
      {
        payloadMaxBytes: 10,
        streamBy: 'global',
        redactor: {
          redact(values) {
            return { ...values, secret: '[REDACTED]' }
          },
        },
        crypto: {
          async encrypt(candidate) {
            observedPayloads.push(candidate)
            return {
              ...candidate,
              oldValues: { secret: encryptedValue },
              newValues: { secret: encryptedValue },
              metadata: { secret: encryptedValue },
            }
          },
        },
      }
    )

    assert.lengthOf(observedPayloads, 1)
    assert.deepEqual(observedPayloads[0].oldValues, { secret: '[REDACTED]' })
    assert.deepEqual(observedPayloads[0].newValues, { secret: '[REDACTED]' })
    assert.deepEqual(observedPayloads[0].metadata, { secret: '[REDACTED]' })

    const expectedDigest = createHash('sha256')
      .update(JSON.stringify({ secret: encryptedValue }))
      .digest('hex')
    for (const payload of [event.oldValues, event.newValues, event.metadata]) {
      assert.isTrue((payload as Record<string, unknown>)._truncated)
      assert.equal((payload as Record<string, unknown>)._sha256, expectedDigest)
    }
  })
})
