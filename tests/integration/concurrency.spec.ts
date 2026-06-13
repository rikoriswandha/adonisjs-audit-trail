import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import Audit from '../../src/models/audit.js'
import { createTestAppWithDb } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { startContainer, type ContainerHandle } from '../helpers/containers.js'
import type { AuditEvent } from '../../src/types.js'
import type StoreManager from '../../src/stores/store_manager.js'
import type LucidStore from '../../src/stores/lucid_store.js'

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `event-${crypto.randomUUID()}`,
    event: 'concurrency.test',
    stream: 'default',
    auditableType: null,
    auditableId: null,
    oldValues: null,
    newValues: { n: Math.random() },
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

async function createApp(container: ContainerHandle) {
  const app = await createTestAppWithDb(
    {
      default: 'lucid',
      stores: {
        lucid: async (application: ApplicationService) => {
          const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
          return new LucidStore(application, {})
        },
      },
    },
    container
  )
  await runMigrations(app)
  return app
}

function useStore(manager: StoreManager): LucidStore {
  return manager.use('lucid') as unknown as LucidStore
}

function runConcurrencyTests(): void {
  test.group('Concurrency proof', (group) => {
    group.each.timeout(60_000)

    test('two apps write 5k events each to one stream with gapless sequence', async ({
      assert,
    }) => {
      const container = await startContainer('postgres')
      if (container === null) {
        throw new Error('Postgres container is required for concurrency proof')
      }
      const [app1, app2] = await Promise.all([createApp(container), createApp(container)])

      try {
        const store1 = useStore(await app1.container.make('audit.manager'))
        const store2 = useStore(await app2.container.make('audit.manager'))

        const perApp = 5_000
        const batchSize = 100

        const batches1: Promise<unknown>[] = []
        const batches2: Promise<unknown>[] = []

        for (let i = 0; i < perApp / batchSize; i++) {
          const batch = Array.from({ length: batchSize }, () => makeEvent())
          batches1.push(store1.write(batch))
          batches2.push(store2.write(batch))
        }

        await Promise.all([...batches1, ...batches2])

        const rows = await Audit.query().orderBy('seq', 'asc')
        assert.equal(rows.length, perApp * 2)

        const seqs = rows.map((row: Audit) => row.seq)
        assert.deepEqual(
          seqs,
          Array.from({ length: perApp * 2 }, (_, i) => i + 1)
        )

        const reports = []
        for await (const report of store1.verify('default')) {
          reports.push(report)
        }
        assert.isAbove(reports.length, 0)
        assert.isTrue(reports[reports.length - 1].valid)
        assert.equal(reports[reports.length - 1].checkedCount, perApp * 2)
      } finally {
        await app1.terminate()
        await app2.terminate()
        await container.stop()
      }
    })

    test('two apps write across 10 tenant streams with independent gapless chains', async ({
      assert,
    }) => {
      const container = await startContainer('postgres')
      if (container === null) {
        throw new Error('Postgres container is required for concurrency proof')
      }
      const [app1, app2] = await Promise.all([createApp(container), createApp(container)])
      try {
        const store1 = useStore(await app1.container.make('audit.manager'))
        const store2 = useStore(await app2.container.make('audit.manager'))

        const tenants = Array.from({ length: 10 }, (_, i) => `tenant-${i}`)
        const eventsPerTenantPerApp = 200
        const batchSize = 50

        const batches: Promise<unknown>[] = []

        for (const tenantId of tenants) {
          for (let i = 0; i < eventsPerTenantPerApp / batchSize; i++) {
            const batch1 = Array.from({ length: batchSize }, () =>
              makeEvent({ stream: tenantId, tenantId })
            )
            const batch2 = Array.from({ length: batchSize }, () =>
              makeEvent({ stream: tenantId, tenantId })
            )
            batches.push(store1.write(batch1))
            batches.push(store2.write(batch2))
          }
        }

        await Promise.all(batches)

        for (const tenantId of tenants) {
          const rows = await Audit.query().where('stream', tenantId).orderBy('seq', 'asc')
          assert.equal(rows.length, eventsPerTenantPerApp * 2)

          const seqs = rows.map((row: Audit) => row.seq)
          assert.deepEqual(
            seqs,
            Array.from({ length: eventsPerTenantPerApp * 2 }, (_, i) => i + 1),
            `tenant ${tenantId} sequence is gapless`
          )

          const reports = []
          for await (const report of store1.verify(tenantId)) {
            reports.push(report)
          }
          assert.isTrue(reports[reports.length - 1].valid, `tenant ${tenantId} chain is valid`)
        }
      } finally {
        await app1.terminate()
        await app2.terminate()
        await container.stop()
      }
    })
  })
}

if (process.env.SKIP_DOCKER_TESTS !== '1') {
  runConcurrencyTests()
}
