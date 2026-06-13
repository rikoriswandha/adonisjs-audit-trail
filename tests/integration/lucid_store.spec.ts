import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import Audit from '../../src/models/audit.js'
import type { AuditEvent } from '../../src/types.js'
import type StoreManager from '../../src/stores/store_manager.js'
import type LucidStore from '../../src/stores/lucid_store.js'

function useStore(manager: StoreManager): LucidStore {
  return manager.use('lucid') as unknown as LucidStore
}

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `event-${crypto.randomUUID()}`,
    event: 'user.created',
    stream: 'default',
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

async function createLucidApp() {
  const app = await createTestApp({
    default: 'lucid',
    stores: {
      lucid: async (application: ApplicationService) => {
        const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
        return new LucidStore(application, {})
      },
    },
  })
  await runMigrations(app)
  return app
}

test.group('LucidStore', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('write roundtrip stores chained rows', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const events = [makeEvent(), makeEvent()]

    const chained = await store.write(events, { getHead: () => store.head('default') })
    assert.lengthOf(chained, 2)
    assert.equal(chained[0].seq, 1)
    assert.equal(chained[1].seq, 2)
    assert.equal(chained[1].prevHash, chained[0].hash)

    const rows = await Audit.query().orderBy('seq', 'asc')
    assert.lengthOf(rows, 2)
    assert.equal(rows[0].event, 'user.created')
    assert.equal(rows[0].seq, 1)
    assert.lengthOf(rows[0].hash, 64)
    assert.lengthOf(rows[0].prevHash, 64)
  })

  test('head returns latest seq and hash', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent(), makeEvent()], { getHead: () => store.head('default') })

    const head = await store.head('default')
    assert.isNotNull(head)
    assert.equal(head?.seq, 2)
    assert.lengthOf(head?.hash ?? '', 64)
  })

  test('verify reports valid chain', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent(), makeEvent()], { getHead: () => store.head('default') })

    const reports = []
    for await (const report of store.verify('default')) {
      reports.push(report)
    }

    assert.isAbove(reports.length, 0)
    assert.equal(reports[reports.length - 1].valid, true)
    assert.equal(reports[reports.length - 1].checkedCount, 2)
  })

  test('verify detects corruption', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent()], { getHead: () => store.head('default') })

    const row = await Audit.query().firstOrFail()
    await Audit.query()
      .where('id', row.id)
      .update({ hash: '0'.repeat(64) })

    const reports = []
    for await (const report of store.verify('default')) {
      reports.push(report)
    }

    assert.isAbove(reports.length, 0)
    assert.equal(reports[reports.length - 1].valid, false)
  })

  test('model save and delete are rejected', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent()], { getHead: () => store.head('default') })

    const row = await Audit.query().firstOrFail()

    try {
      await row.save()
      assert.fail('save should have thrown')
    } catch (err) {
      assert.include((err as Error).message, 'immutable')
    }

    try {
      await row.delete()
      assert.fail('delete should have thrown')
    } catch (err) {
      assert.include((err as Error).message, 'immutable')
    }
  })

  test('query filters by event and stream', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ event: 'a' })], { getHead: () => store.head('default') })
    await store.write([makeEvent({ event: 'b' })], { getHead: () => store.head('default') })

    const rows = await store.query({ event: 'a' })
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].event, 'a')
  })

  test('prune removes old events but keeps head', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const old = makeEvent()
    old.createdAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString()
    await store.write([old], { getHead: () => store.head('default') })

    const recent = makeEvent()
    recent.createdAt = new Date().toISOString()
    await store.write([recent], { getHead: () => store.head('default') })

    const report = await store.prune({ default: '1 day' })
    assert.equal(report.totalPruned, 1)

    const rows = await Audit.query().orderBy('seq', 'asc')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].seq, 2)
  })

  test('multi-stream chains are independent', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const a = await store.write([makeEvent({ stream: 'a' })], { getHead: () => store.head('a') })
    const b = await store.write([makeEvent({ stream: 'b' })], { getHead: () => store.head('b') })

    assert.equal(a[0].seq, 1)
    assert.equal(b[0].seq, 1)
    assert.notEqual(a[0].hash, b[0].hash)
  })
})
