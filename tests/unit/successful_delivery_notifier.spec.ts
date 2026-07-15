import { test } from '@japa/runner'
import { AnchorService } from '../../src/core/anchor.js'
import { RuntimeSuccessfulDeliveryNotifier } from '../../src/core/successful_delivery_notifier.js'
import type { AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'

function chained(id: string): ChainedAuditEvent {
  return {
    id,
    event: 'test',
    stream: 'stream',
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
    seq: 1,
    hash: 'a'.repeat(64),
    prevHash: '0'.repeat(64),
  }
}

const store: AuditStoreContract = {
  async write() {
    return []
  },
  async head() {
    return null
  },
  async *verify() {},
  async prune() {
    return { streams: [], totalPruned: 0, perEvent: {} }
  },
}

test('successful delivery uses one notifier effect per event ID', async ({ assert }) => {
  let emitted = 0
  const anchored: string[] = []
  const anchor = new AnchorService({
    every: 1,
    async publish(head) {
      anchored.push(head.hash)
    },
  })
  const notifier = new RuntimeSuccessfulDeliveryNotifier(
    {
      async emit() {
        emitted++
      },
    },
    anchor
  )
  const event = chained('event-1')

  await notifier.notify(store, [event])
  await notifier.notify(store, [event])

  assert.equal(emitted, 1)
  assert.deepEqual(anchored, [event.hash])
})
