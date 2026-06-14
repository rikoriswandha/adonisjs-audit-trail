import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditEvent, AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'

function makeOutboxEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `event-${crypto.randomUUID()}`,
    event: 'outbox.drained',
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

function createRecordingStore(): { store: AuditStoreContract; writes: AuditEvent[][] } {
  const writes: AuditEvent[][] = []

  return {
    writes,
    store: {
      async write(batch) {
        writes.push(batch)
        return batch.map((event, index) => ({
          ...event,
          seq: writes.length + index,
          hash: `hash-${writes.length}-${index}`,
          prevHash: '',
        })) as ChainedAuditEvent[]
      },
      async head() {
        return null
      },
      async *verify() {},
      async prune() {
        return { streams: [], totalPruned: 0, perEvent: {} }
      },
    },
  }
}
type PoisonHandler = (info: { id: string | number; payload: unknown; attempts: number }) => void

type DrainerConstructor = new (
  app: ApplicationService,
  store: AuditStoreContract,
  staleClaimMs?: number,
  maxAttempts?: number,
  onPoison?: PoisonHandler
) => { drain(limit?: number): Promise<number> }

async function importOutboxDrainer(): Promise<DrainerConstructor> {
  const module = (await import('../../src/core/outbox_drainer.js')) as {
    default: DrainerConstructor
  }
  return module.default
}

async function createOutboxApp(dialect: string = 'sqlite') {
  const app = await createTestApp({}, dialect as any)
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

  test('dead-letters a poison row once after max attempts', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    const client = db.connection()
    const { store, writes } = createRecordingStore()
    const poisonRows: Array<{ id: string | number; payload: unknown; attempts: number }> = []
    const maxAttempts = 3
    const now = new Date()

    await client.table('audit_outbox').insert({
      id: 1,
      payload: JSON.stringify({ garbage: true }),
      attempts: 0,
      created_at: now,
      updated_at: now,
    })

    const AuditOutboxDrainer = await importOutboxDrainer()
    const drainer = new AuditOutboxDrainer(app, store, undefined, maxAttempts, (info) => {
      poisonRows.push(info)
    })

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await drainer.drain()
    }

    assert.lengthOf(writes, 0, 'poison row never reaches the store')
    assert.lengthOf(poisonRows, 1, 'poison handler called exactly once')
    assert.equal(poisonRows[0].id, 1)
    assert.isAtLeast(poisonRows[0].attempts, maxAttempts)

    const deadLettered = await client.query().from('audit_outbox').where('id', 1).first()
    assert.isNotNull(deadLettered?.processed_at, 'poison row is marked processed')
    assert.equal(Number(deadLettered?.attempts), maxAttempts)

    await drainer.drain()

    const afterDrain = await client.query().from('audit_outbox').where('id', 1).first()
    assert.lengthOf(poisonRows, 1, 'processed poison row is not reported again')
    assert.equal(
      Number(afterDrain?.attempts),
      maxAttempts,
      'processed poison row is not re-claimed'
    )
    assert.isNotNull(afterDrain?.processed_at, 'poison row stays processed')
  })

  test('drains valid outbox rows normally', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    const client = db.connection()
    const { store, writes } = createRecordingStore()
    const event = makeOutboxEvent()
    const now = new Date()

    await client.table('audit_outbox').insert({
      id: 1,
      payload: JSON.stringify({ event }),
      attempts: 0,
      created_at: now,
      updated_at: now,
    })

    const AuditOutboxDrainer = await importOutboxDrainer()
    const drainer = new AuditOutboxDrainer(app, store, undefined, 3, () => {})

    assert.equal(await drainer.drain(), 1)
    assert.lengthOf(writes, 1)
    assert.equal(writes[0][0].id, event.id)

    const row = await client.query().from('audit_outbox').where('id', 1).first()
    assert.isNotNull(row?.processed_at, 'valid row is marked processed')
    assert.equal(Number(row?.attempts), 1)
  })
})
