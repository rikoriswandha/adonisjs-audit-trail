import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditEvent, AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'
import {
  RuntimeSuccessfulDeliveryNotifier,
  type SuccessfulDeliveryNotifier,
} from '../../src/core/successful_delivery_notifier.js'
import AuditOutboxDrainer from '../../src/core/outbox_drainer.js'
import LucidStore from '../../src/stores/lucid_store.js'
import { chainBatch } from '../../src/core/hash_chain.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import type { DbDialect } from '../helpers/dialect.js'
import { withDatabases } from '../helpers/matrix.js'

function makeOutboxEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: crypto.randomUUID(),
    event: 'outbox.drained',
    stream: 'global',
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

function createRecordingStore(failures = 0): {
  store: AuditStoreContract
  attempts: number
  writes: AuditEvent[][]
} {
  const writes: AuditEvent[][] = []
  const events: ChainedAuditEvent[] = []
  let attempts = 0

  return {
    get attempts() {
      return attempts
    },
    writes,
    store: {
      async write(batch) {
        attempts++
        if (attempts <= failures) throw new Error('target unavailable')
        writes.push(batch)
        const chained = chainBatch(batch, events.at(-1) ?? null)
        events.push(...chained)
        return chained
      },
      async head(stream) {
        const event = events.filter((candidate) => candidate.stream === stream).at(-1)
        return event ? { seq: event.seq, hash: event.hash } : null
      },
      async *verify() {},
      async prune() {
        return { streams: [], totalPruned: 0, perEvent: {} }
      },
    },
  }
}

function createNotifier(): { notifier: SuccessfulDeliveryNotifier; notifications: string[][] } {
  const notifications: string[][] = []
  return {
    notifications,
    notifier: {
      async notify(_store, events) {
        notifications.push(events.map((event) => event.id))
      },
    },
  }
}

async function insertOutboxRow(
  app: ApplicationService,
  payload: unknown,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const db = await app.container.make('lucid.db')
  const id = crypto.randomUUID()
  const now = new Date()
  await db
    .connection()
    .table('audit_outbox')
    .insert({
      id,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      tenant_id: null,
      status: 'pending',
      attempts: 0,
      available_at: now,
      created_at: now,
      ...overrides,
    })
  return id
}

async function createOutboxApp(dialect: DbDialect = 'sqlite') {
  const app = await createTestApp({}, dialect)
  await runMigrations(app)
  return app
}

withDatabases('Audit outbox drainer', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createOutboxApp(dialect)
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('uses separate source and target databases and notifies after delivery', async ({
    assert,
  }) => {
    const targetApp = await createOutboxApp(dialect)
    try {
      const event = makeOutboxEvent()
      const rowId = await insertOutboxRow(app, { event }, { tenant_id: 'tenant-source' })
      const { notifier, notifications } = createNotifier()
      const drainer = new AuditOutboxDrainer(
        app,
        new LucidStore(targetApp, { connection: dialect }),
        { connection: dialect },
        notifier
      )

      assert.equal(await drainer.drain(), 1)

      const sourceDb = await app.container.make('lucid.db')
      const targetDb = await targetApp.container.make('lucid.db')
      const sourceRow = await sourceDb
        .connection()
        .query()
        .from('audit_outbox')
        .where('id', rowId)
        .first()
      const sourceAudits = await sourceDb.connection().query().from('audits')
      const targetAudit = await targetDb
        .connection()
        .query()
        .from('audits')
        .where('id', event.id)
        .first()

      assert.equal(sourceRow?.status, 'processed')
      assert.lengthOf(sourceAudits, 0)
      assert.isNotNull(targetAudit)
      assert.deepEqual(notifications, [[event.id]])
    } finally {
      await cleanupTestApp(targetApp)
    }
  })

  test('replays idempotently after target success and source acknowledgement failure', async ({
    assert,
  }) => {
    const targetApp = await createOutboxApp(dialect)
    try {
      const event = makeOutboxEvent()
      const rowId = await insertOutboxRow(app, { event }, { tenant_id: 'tenant-a' })
      const sourceDb = await app.container.make('lucid.db')
      let executorCalls = 0
      let notifications = 0
      const notifier = new RuntimeSuccessfulDeliveryNotifier({
        async emit() {
          notifications++
        },
      })
      const drainer = new AuditOutboxDrainer(
        app,
        new LucidStore(targetApp, { connection: dialect }),
        {
          connection: dialect,
          executor: async (_tenantId, operation) => {
            executorCalls++
            if (executorCalls === 2) {
              throw new Error('source acknowledgement unavailable')
            }
            return sourceDb.connection().transaction(operation)
          },
        },
        notifier
      )

      assert.equal(await drainer.drain(), 0)
      assert.equal(await drainer.drain(), 1)

      const sourceRow = await sourceDb
        .connection()
        .query()
        .from('audit_outbox')
        .where('id', rowId)
        .first()
      const targetDb = await targetApp.container.make('lucid.db')
      const targetRows = await targetDb.connection().query().from('audits').where('id', event.id)

      assert.equal(sourceRow?.status, 'processed')
      assert.lengthOf(targetRows, 1)
      assert.equal(notifications, 1)
    } finally {
      await cleanupTestApp(targetApp)
    }
  })

  test('rolls back source outbox intents with their caller transaction', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    const id = crypto.randomUUID()

    try {
      await db.connection().transaction(async (trx) => {
        await trx
          .insertQuery()
          .table('audit_outbox')
          .insert({
            id,
            payload: JSON.stringify({ event: makeOutboxEvent() }),
            tenant_id: 'tenant-a',
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            created_at: new Date(),
          })
        throw new Error('business transaction rolled back')
      })
    } catch (error) {
      assert.instanceOf(error, Error)
    }

    assert.isNull(await db.connection().query().from('audit_outbox').where('id', id).first())
  })

  test('keeps source intent pending when target delivery fails, then delivers exactly once', async ({
    assert,
  }) => {
    const event = makeOutboxEvent()
    const rowId = await insertOutboxRow(app, { event })
    const target = createRecordingStore(1)
    const { notifier, notifications } = createNotifier()
    const drainer = new AuditOutboxDrainer(app, target.store, {}, notifier)

    assert.equal(await drainer.drain(), 0)
    const db = await app.container.make('lucid.db')
    let row = await db.connection().query().from('audit_outbox').where('id', rowId).first()
    assert.equal(row?.status, 'pending')
    assert.equal(Number(row?.attempts), 1)

    assert.equal(await drainer.drain(), 1)
    row = await db.connection().query().from('audit_outbox').where('id', rowId).first()
    assert.equal(row?.status, 'processed')
    assert.equal(target.attempts, 2)
    assert.lengthOf(target.writes, 1)
    assert.deepEqual(notifications, [[event.id]])
  })

  test('fails a mixed malformed payload atomically without target delivery', async ({ assert }) => {
    const event = makeOutboxEvent()
    const rowId = await insertOutboxRow(app, [event, { malformed: true }])
    const target = createRecordingStore()
    const { notifier } = createNotifier()
    const drainer = new AuditOutboxDrainer(app, target.store, {}, notifier, () => {})

    assert.equal(await drainer.drain(), 0)

    const db = await app.container.make('lucid.db')
    const row = await db.connection().query().from('audit_outbox').where('id', rowId).first()
    assert.equal(row?.status, 'failed')
    assert.equal(Number(row?.attempts), 1)
    assert.isNotNull(row?.failed_at)
    assert.match(String(row?.last_error), /invalid audit event/)
    assert.lengthOf(target.writes, 0)
  })

  test('requeues terminal failures and exposes durable relay metrics', async ({ assert }) => {
    const event = makeOutboxEvent()
    const rowId = await insertOutboxRow(app, { event })
    const target = createRecordingStore(1)
    const { notifier } = createNotifier()
    const drainer = new AuditOutboxDrainer(
      app,
      target.store,
      { maxAttempts: 1 },
      notifier,
      () => {}
    )

    assert.equal(await drainer.drain(), 0)
    const failedMetrics = await drainer.stats()
    assert.equal(failedMetrics.failed, 1)
    assert.equal(failedMetrics.attempts, 1)
    assert.equal(failedMetrics.pending, 0)

    assert.equal(await drainer.requeue(), 1)
    const requeuedMetrics = await drainer.stats()
    assert.equal(requeuedMetrics.failed, 0)
    assert.equal(requeuedMetrics.pending, 1)
    assert.isNotNull(requeuedMetrics.oldestPendingAgeMs)

    assert.equal(await drainer.drain(), 1)
    const db = await app.container.make('lucid.db')
    const row = await db.connection().query().from('audit_outbox').where('id', rowId).first()
    assert.equal(row?.status, 'processed')
  })

  test('runs claims and acknowledgements through the tenant executor', async ({ assert }) => {
    const event = makeOutboxEvent({ tenantId: 'tenant-a' })
    await insertOutboxRow(app, { event }, { tenant_id: 'tenant-a' })
    const target = createRecordingStore()
    const { notifier } = createNotifier()
    const db = await app.container.make('lucid.db')
    const tenants: (string | null)[] = []
    const transactionTenants: string[] = []
    const drainer = new AuditOutboxDrainer(
      app,
      target.store,
      {
        executor: async (tenantId, operation) => {
          tenants.push(tenantId)
          return db.connection().transaction(async (trx) => {
            if (dialect === 'postgres') {
              if (tenantId === null) throw new Error('PostgreSQL tenant executor requires a tenant')
              await trx.rawQuery(`select set_config('app.tenant_id', ?, true)`, [tenantId])
              const setting = (await trx.rawQuery(
                `select current_setting('app.tenant_id', true) as tenant_id`
              )) as { rows: { tenant_id: string }[] }
              transactionTenants.push(setting.rows[0].tenant_id)
            }
            return operation(trx)
          })
        },
      },
      notifier
    )

    assert.equal(await drainer.drain(), 1)
    assert.deepEqual(tenants, ['tenant-a', 'tenant-a'])
    if (dialect === 'postgres') {
      assert.deepEqual(transactionTenants, ['tenant-a', 'tenant-a'])
    }
  })
})
