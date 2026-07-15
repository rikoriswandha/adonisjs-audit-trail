import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import Audit from '../../src/models/audit.js'
import type { AuditEvent } from '../../src/types.js'
import type StoreManager from '../../src/stores/store_manager.js'
import type LucidStore from '../../src/stores/lucid_store.js'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AuditOutboxIntegrityError } from '../../src/core/errors.js'

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

function privilegedMaintenance(dialect: string) {
  return async (trx: TransactionClientContract) => {
    if (dialect === 'postgres') {
      await trx.rawQuery("SELECT set_config('audit.maintenance', 'prune', true)")
      return
    }
    if (dialect === 'mysql' || dialect === 'mysql2') {
      await trx.rawQuery("SET @audit_maintenance = 'prune'")
      return
    }
    await trx.insertQuery().table('audit_maintenance_guard').insert({ operation: 'prune' })
  }
}

async function createLucidApp(dialect: string = 'sqlite') {
  const app = await createTestApp(
    {
      default: 'lucid',
      stores: {
        lucid: async (application: ApplicationService) => {
          const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
          return new LucidStore(application, { maintenance: privilegedMaintenance(dialect) })
        },
      },
    },
    dialect as any
  )
  await runMigrations(app)
  return app
}

async function installSqliteDeleteTrigger(
  app: ApplicationService,
  name: string,
  condition: string = "NOT EXISTS (SELECT 1 FROM audit_maintenance_guard WHERE operation = 'prune')"
) {
  const db = await app.container.make('lucid.db')
  await db
    .connection()
    .rawQuery(
      `CREATE TRIGGER ${name} BEFORE DELETE ON audits WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END`
    )
}
async function installImmutableDeleteTrigger(
  app: ApplicationService,
  dialect: string,
  name: string
) {
  if (dialect === 'sqlite') {
    await installSqliteDeleteTrigger(app, name)
    return
  }

  const db = await app.container.make('lucid.db')
  if (dialect === 'postgres') {
    await db.connection().rawQuery(`
      CREATE OR REPLACE FUNCTION prevent_audit_test_delete()
      RETURNS trigger AS $$
      BEGIN
        IF current_setting('audit.maintenance', true) = 'prune' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit rows are immutable';
      END;
      $$ LANGUAGE plpgsql
    `)
    await db
      .connection()
      .rawQuery(
        `CREATE TRIGGER ${name} BEFORE DELETE ON audits FOR EACH ROW EXECUTE FUNCTION prevent_audit_test_delete()`
      )
    return
  }

  await db.connection().rawQuery(`
    CREATE TRIGGER ${name} BEFORE DELETE ON audits FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_maintenance, '') <> 'prune' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows are immutable';
      END IF;
    END
  `)
}

withDatabases('LucidStore', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp(dialect)
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('write roundtrip stores chained rows', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const events = [makeEvent(), makeEvent()]

    const chained = await store.write(events)
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

  test('treats identical event IDs as idempotent and rejects conflicting content', async ({
    assert,
  }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const event = makeEvent()

    const [first] = await store.write([event])
    const [replayed] = await store.write([{ ...event, actor: { ...event.actor } }])

    assert.equal(replayed.id, first.id)
    assert.equal(replayed.seq, first.seq)
    assert.lengthOf(await Audit.query().where('id', event.id), 1)

    await assert.rejects(
      () => store.write([{ ...event, event: 'user.changed' }]),
      AuditOutboxIntegrityError
    )
  })

  test('head returns latest seq and hash', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent(), makeEvent()])

    const head = await store.head('default')
    assert.isNotNull(head)
    assert.equal(head?.seq, 2)
    assert.lengthOf(head?.hash ?? '', 64)
  })

  test('verify reports valid chain', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent(), makeEvent()])

    const reports = []
    for await (const report of store.verify('default')) {
      reports.push(report)
    }

    assert.isAbove(reports.length, 0)
    assert.equal(reports[reports.length - 1].valid, true)
    assert.equal(reports[reports.length - 1].checkedCount, 2)
  })

  test('verify supports ranges starting after genesis', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({ id: 'range-1' }),
      makeEvent({ id: 'range-2' }),
      makeEvent({ id: 'range-3' }),
    ])

    const reports = []
    for await (const report of store.verify('default', { fromSeq: 2 })) {
      reports.push(report)
    }

    assert.lengthOf(reports, 2)
    assert.isTrue(reports.every((report) => report.valid))
    assert.equal(reports[0].checkedCount, 1)
  })

  test('verify detects corruption', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent()])

    const row = await Audit.query().firstOrFail()
    const db = await app.container.make('lucid.db')
    await db
      .connection()
      .query()
      .from('audits')
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
    await store.write([makeEvent()])

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

  test('query builder update and delete are rejected', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent()])

    await assert.rejects(
      () => Audit.query().where('event', 'user.created').update({ actor_label: 'changed' }),
      /immutable/i
    )
    await assert.rejects(() => Audit.query().where('event', 'user.created').delete(), /immutable/i)
  })

  test('query filters by event and stream', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ event: 'a' })])
    await store.write([makeEvent({ event: 'b' })])

    const rows = await store.query({ event: 'a' })
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].event, 'a')
  })

  test('prune removes old events but keeps head', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const old = makeEvent()
    old.createdAt = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString()
    await store.write([old])

    const recent = makeEvent()
    recent.createdAt = new Date().toISOString()
    await store.write([recent])

    const report = await store.prune({ default: '1 day' })
    assert.equal(report.totalPruned, 1)

    const rows = await Audit.query().orderBy('seq', 'asc')
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].seq, 2)
  })

  test('rejects an unprivileged physical prune before touching immutable rows', async ({
    assert,
  }) => {
    await installImmutableDeleteTrigger(app, dialect, 'audits_delete_requires_maintenance')

    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({
        id: 'unprivileged-old',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
      makeEvent({ id: 'unprivileged-head' }),
    ])

    const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
    const unprivileged = new LucidStore(app, {})
    await assert.rejects(
      () => unprivileged.prune({ default: '1 day' }),
      /requires a LucidStore maintenance operation/i
    )

    const db = await app.container.make('lucid.db')
    await assert.rejects(
      () => db.connection().query().from('audits').where('id', 'unprivileged-old').delete(),
      /immutable/i
    )
  })

  test('uses configured maintenance to prune through an immutable trigger', async ({ assert }) => {
    await installImmutableDeleteTrigger(app, dialect, 'audits_delete_requires_prune_guard')

    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({
        id: 'privileged-old',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
      makeEvent({ id: 'privileged-head' }),
    ])

    const report = await store.prune({ default: '1 day' })
    assert.equal(report.totalPruned, 1)
    assert.isNull(await Audit.query().where('id', 'privileged-old').first())
  })

  test('archives a segment once when deletion fails and the prune is retried', async ({
    assert,
  }) => {
    if (dialect !== 'sqlite') return

    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({
        id: 'retry-old',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
      makeEvent({ id: 'retry-head' }),
    ])
    await installSqliteDeleteTrigger(app, 'audits_delete_always_fails', '1 = 1')

    const archived: string[] = []
    const archive = async (segment: { idempotencyKey: string }) => {
      archived.push(segment.idempotencyKey)
    }
    await assert.rejects(() => store.prune({ default: '1 day', archive }), /immutable/i)

    const db = await app.container.make('lucid.db')
    assert.isNotNull(await Audit.query().where('id', 'retry-old').first())
    assert.isNotNull(
      await db.connection().query().from('audit_archive_events').where('id', 'retry-old').first()
    )
    await db.connection().rawQuery('DROP TRIGGER audits_delete_always_fails')
    const report = await store.prune({ default: '1 day', archive })

    assert.equal(report.totalPruned, 1)
    assert.deepEqual(archived, ['default:1:1'])
    assert.isNotNull(
      await db.connection().query().from('audit_archive_events').where('id', 'retry-old').first()
    )
  })

  test('verifies the live chain from its prune checkpoint', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({
        id: 'checkpoint-old-1',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
      makeEvent({
        id: 'checkpoint-old-2',
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
      makeEvent({ id: 'checkpoint-head' }),
    ])

    const report = await store.prune({ default: '1 day' })
    assert.equal(report.totalPruned, 2)

    const reports = []
    for await (const verification of store.verify('default')) reports.push(verification)
    assert.lengthOf(reports, 1)
    assert.isTrue(reports[0].valid)
    assert.equal(reports[0].checkedCount, 1)
  })

  test('multi-stream chains are independent', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    const a = await store.write([makeEvent({ stream: 'a' })])
    const b = await store.write([makeEvent({ stream: 'b' })])

    assert.equal(a[0].seq, 1)
    assert.equal(b[0].seq, 1)
    assert.notEqual(a[0].hash, b[0].hash)
  })
})

withDatabases(
  'LucidStore MySQL lock validation',
  (group, dialect) => {
    let app: ApplicationService

    group.each.setup(async () => {
      app = await createLucidApp(dialect)
    })

    group.each.teardown(async () => {
      await cleanupTestApp(app)
    })

    test('rejects a write when GET_LOCK is not acquired', async ({ assert }) => {
      const db = await app.container.make('lucid.db')
      const lock = 'default'
      const holder = await db.connection().transaction()
      const acquired = await holder.rawQuery('SELECT GET_LOCK(?, 0) AS lock_status', [lock])
      assert.equal(acquired[0]?.[0]?.lock_status, 1)

      try {
        const store = useStore(await app.container.make('audit.manager'))
        await assert.rejects(
          () => store.write([makeEvent()]),
          /Could not acquire MySQL advisory lock/
        )
      } finally {
        await holder.rawQuery('SELECT RELEASE_LOCK(?)', [lock])
        await holder.commit()
      }
    })
  },
  { only: ['mysql'] }
)
