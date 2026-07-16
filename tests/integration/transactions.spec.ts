import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import Audit from '../../src/models/audit.js'
import type { AuditStoreContract, AuditEvent } from '../../src/types.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import { Post } from '../helpers/models.js'
import AuditOutboxDrainer from '../../src/core/outbox_drainer.js'
import type { SuccessfulDeliveryNotifier } from '../../src/core/successful_delivery_notifier.js'
import { AuditTransactionRequiredError } from '../../src/core/errors.js'

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function decodeOutboxPayload(payload: unknown): { event: AuditEvent } {
  const decoded: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !('event' in decoded) ||
    !decoded.event ||
    typeof decoded.event !== 'object' ||
    !('id' in decoded.event) ||
    typeof decoded.event.id !== 'string'
  ) {
    throw new TypeError('Outbox payload does not contain an audit event')
  }

  return decoded as { event: AuditEvent }
}

function createSlowStore(base: AuditStoreContract, delayMs: number): AuditStoreContract {
  return {
    ...base,
    async write(batch) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return base.write(batch)
    },
  }
}

function makeOutboxEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `event-${crypto.randomUUID()}`,
    event: 'outbox.race',
    stream: 'default',
    auditableType: null,
    auditableId: null,
    oldValues: null,
    newValues: { title: 'Race' },
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

async function createLucidApp(dialect: string = 'sqlite', auditConfig = {}) {
  const app = await createTestApp(
    {
      default: 'lucid',
      ...auditConfig,
      stores: {
        lucid: async (application: ApplicationService) => {
          const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
          return new LucidStore(application, {})
        },
      },
    },
    dialect as any
  )
  await runMigrations(app)
  return app
}

async function waitForAudits(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await Audit.query()
    const count = rows.length
    if (count >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

withDatabases('Auditable transactions', (_group, dialect) => {
  test('rolled-back transactions do not enqueue audit rows', async ({ assert }) => {
    const app = await createLucidApp(dialect)

    try {
      const db = await app.container.make('lucid.db')
      await db.transaction(async (trx) => {
        const post = new Post()
        post.title = 'Rollback'
        post.body = null
        post.useTransaction(trx)
        await post.save()
        throw new Error('rollback')
      })
    } catch (error) {
      assert.instanceOf(error, Error)
    }

    await waitForAudits(1)
    assert.lengthOf(await Audit.query(), 0)
    await cleanupTestApp(app)
  })

  test('transactional-outbox co-commits and drains model audit events', async ({ assert }) => {
    const app = await createLucidApp(dialect, { guarantee: 'transactional-outbox' })

    try {
      const db = await app.container.make('lucid.db')
      await db.transaction(async (trx) => {
        const post = new Post()
        post.title = 'Outbox'
        post.body = null
        post.useTransaction(trx)
        await post.save()
      })

      const outboxRows = await db.query().from('audit_outbox').whereNull('processed_at')
      assert.lengthOf(outboxRows, 1)

      const [outboxRow] = outboxRows
      const payload = decodeOutboxPayload(outboxRow?.payload)
      assert.isNotNull(outboxRow?.id, 'outbox row has an ID')
      assert.match(String(outboxRow?.id), UUID_V7_PATTERN, 'outbox row ID is UUIDv7')
      assert.notEqual(String(outboxRow?.id), payload.event.id, 'row and event IDs are distinct')

      const drainer = await app.container.make('audit.outbox_drainer')
      assert.equal(await drainer.drain(), 1)

      const row = await Audit.query().where('event', 'model.created').firstOrFail()
      assert.equal(row.newValues?.title, 'Outbox')
    } finally {
      await cleanupTestApp(app)
    }
  })

  test('transactional-outbox intent failures roll back business data with default model strictness', async ({
    assert,
  }) => {
    const app = await createLucidApp(dialect, {
      guarantee: 'transactional-outbox',
      outbox: { table: 'missing_audit_outbox' },
    })

    try {
      const db = await app.container.make('lucid.db')

      await assert.rejects(() =>
        db.transaction(async (trx) => {
          const post = new Post()
          post.title = 'Outbox insert failure'
          post.body = null
          post.useTransaction(trx)
          await post.save()
        })
      )

      assert.lengthOf(await db.query().from('posts'), 0, 'business row rolled back')
      assert.lengthOf(await db.query().from('audit_outbox'), 0, 'no outbox row persisted')
    } finally {
      await cleanupTestApp(app)
    }
  })

  test('transactional-outbox model creates require a caller transaction before persistence', async ({
    assert,
  }) => {
    const app = await createLucidApp(dialect, { guarantee: 'transactional-outbox' })

    try {
      const db = await app.container.make('lucid.db')

      await assert.rejects(
        () => Post.create({ title: 'Missing transaction', body: null }),
        AuditTransactionRequiredError
      )

      assert.lengthOf(await db.query().from('posts'), 0, 'business row was not inserted')
      assert.lengthOf(await db.query().from('audit_outbox'), 0, 'outbox was not written')
    } finally {
      await cleanupTestApp(app)
    }
  })

  test('concurrent drainers do not double-process a pending outbox row', async ({ assert }) => {
    const app = await createLucidApp(dialect, { guarantee: 'transactional-outbox' })

    try {
      const db = await app.container.make('lucid.db')
      const client = db.connection()
      const manager = await app.container.make('audit.manager')
      const store = createSlowStore(manager.use(), 50)

      await client.table('audit_outbox').insert({
        id: crypto.randomUUID(),
        payload: JSON.stringify({ event: makeOutboxEvent() }),
        tenant_id: null,
        status: 'pending',
        attempts: 0,
        available_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      })

      const notifier = (await app.container.make(
        'audit.delivery_notifier'
      )) as SuccessfulDeliveryNotifier
      const drainer1 = new AuditOutboxDrainer(app, store, {}, notifier)
      const drainer2 = new AuditOutboxDrainer(app, store, {}, notifier)

      const [processed1, processed2] = await Promise.all([drainer1.drain(), drainer2.drain()])

      assert.equal(processed1 + processed2, 1, 'only one drainer processed the row')
      assert.lengthOf(await Audit.query(), 1, 'audit row written at most once')

      const outboxRow = await client.query().from('audit_outbox').first()
      assert.isNotNull(outboxRow?.processed_at, 'outbox row marked processed')
      assert.equal(outboxRow?.attempts, 1, 'attempts incremented exactly once')
    } finally {
      await cleanupTestApp(app)
    }
  })
})
