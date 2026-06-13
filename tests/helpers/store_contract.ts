import { test } from '@japa/runner'
import type { AuditEvent, AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'

export interface StoreCapabilities {
  verifiable: boolean
  corruptable: boolean
  prunable: boolean
}

export interface StoreContractFactory {
  name: string
  create: () => Promise<AuditStoreContract>
  capabilities?: Partial<StoreCapabilities>
}

function event(
  id: string,
  stream: string = 'default',
  overrides: Partial<AuditEvent> = {}
): AuditEvent {
  return {
    id,
    event: 'user.created',
    stream,
    auditableType: 'User',
    auditableId: '1',
    oldValues: null,
    newValues: { name: 'Ada' },
    metadata: null,
    actor: { type: 'user', id: '1', label: 'ada@example.com' },
    tenantId: null,
    requestId: 'r1',
    correlationId: 'c1',
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    url: 'http://localhost',
    httpMethod: 'POST',
    tags: [],
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

export function storeContractTests(factory: StoreContractFactory) {
  const capabilities: StoreCapabilities = {
    verifiable: true,
    corruptable: true,
    prunable: true,
    ...factory.capabilities,
  }

  test.group(`${factory.name} store contract`, (group) => {
    let store: AuditStoreContract

    group.each.setup(async () => {
      store = await factory.create()
    })

    test('write returns chained events', async ({ assert }) => {
      const chained = await store.write([event('a'), event('b')])

      assert.lengthOf(chained, 2)
      assert.equal(chained[0]!.seq, 1)
      assert.equal(chained[1]!.seq, 2)
      assert.equal(chained[1]!.prevHash, chained[0]!.hash)
      assert.lengthOf(chained[0]!.hash, 64)
      assert.lengthOf(chained[1]!.hash, 64)
    })

    test('head returns latest seq and hash', async ({ assert }) => {
      await store.write([event('a'), event('b')])
      const head = await store.head('default')

      assert.isNotNull(head)
      assert.equal(head!.seq, 2)
      assert.lengthOf(head!.hash, 64)
    })

    if (capabilities.verifiable) {
      test('verify reports valid chain', async ({ assert }) => {
        await store.write([event('a'), event('b')])
        const reports = []

        for await (const report of store.verify('default')) {
          reports.push(report)
        }

        assert.isAtLeast(reports.length, 1)
        assert.isTrue(reports[reports.length - 1]!.valid)
      })
    }

    if (capabilities.corruptable) {
      test('verify detects corruption', async ({ assert }) => {
        const [first] = await store.write([event('a'), event('b')])
        await corrupt(store, first!)

        const reports = []
        for await (const report of store.verify('default')) {
          reports.push(report)
        }

        const invalid = reports.find((r) => !r.valid)
        assert.isDefined(invalid)
      })
    }

    if (capabilities.prunable) {
      test('prune returns a report', async ({ assert }) => {
        const report = await store.prune({ default: '1 day' })
        assert.isObject(report)
        assert.isArray(report.streams)
        assert.isNumber(report.totalPruned)
      })
    }
  })
}

async function corrupt(store: AuditStoreContract, chainedEvent: ChainedAuditEvent): Promise<void> {
  const corrupted = { ...chainedEvent, hash: '0'.repeat(64) }
  await store.write([corrupted])
}
