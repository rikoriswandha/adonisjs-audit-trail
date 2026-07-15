import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import { Post } from '../helpers/models.js'
import Audit from '../../src/models/audit.js'
import type { AuditEvent, AuditableModelInstance } from '../../src/types.js'
import type { AuditQuery } from '../../src/models/audit.js'
import type LucidStore from '../../src/stores/lucid_store.js'
import type StoreManager from '../../src/stores/store_manager.js'

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
    newValues: null,
    metadata: null,
    actor: { type: 'user', id: '1' },
    tenantId: 'acme',
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

async function createLucidApp(dialect: string = 'sqlite') {
  const app = await createTestApp(
    {
      default: 'lucid',
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

withDatabases('Audit model scopes', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp(dialect)
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('Auditable exposes its query methods in the instance type', ({ expectTypeOf }) => {
    expectTypeOf<Post>().toMatchTypeOf<AuditableModelInstance>()
    expectTypeOf<Post['audits']>().returns.toEqualTypeOf<AuditQuery>()
    expectTypeOf<Post['lastAudit']>().toEqualTypeOf<AuditableModelInstance['lastAudit']>()
  })
  test('forModel scopes by type and id', async ({ assert }) => {
    const post = await Post.createQuietly({ title: 'Hello', body: null })
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ auditableType: 'Post', auditableId: String(post.id) })])
    await store.write([makeEvent({ auditableType: 'Post', auditableId: '999' })])

    const rows = await Audit.query().apply((scopes) => scopes.forModel(post))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].auditableId, String(post.id))
  })

  test('forModel resolves a custom primary key', async ({ assert }) => {
    class ExternalKeyPost extends Post {
      static primaryKey = 'externalId'
      declare externalId: string
    }

    const post = new ExternalKeyPost()
    post.externalId = 'post-external-42'
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({
        auditableType: 'ExternalKeyPost',
        auditableId: post.externalId,
      }),
      makeEvent({ auditableType: 'ExternalKeyPost', auditableId: 'other' }),
    ])

    const rows = await Audit.query().apply((scopes) => scopes.forModel(post))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].auditableId, post.externalId)
  })

  test('byActor filters by the supplied actor type', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({ actor: { type: 'user', id: 'actor-1' } }),
      makeEvent({ actor: { type: 'system', id: 'actor-1' } }),
    ])

    const rows = await Audit.query().apply((scopes) =>
      scopes.byActor({ type: 'user', id: 'actor-1' })
    )
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].actorType, 'user')
  })

  test('uses cursor as an exclusive stream sequence', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([
      makeEvent({ stream: 'cursor-stream' }),
      makeEvent({ stream: 'cursor-stream' }),
      makeEvent({ stream: 'cursor-stream' }),
    ])

    const rows = await store.query({ stream: 'cursor-stream', cursor: 2 })
    assert.deepEqual(
      rows.map((row) => row.seq),
      [3]
    )
  })

  test('reads through a named connection and caller transaction', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ stream: 'read-options' })])

    const namedStore = store.withConnection(dialect) as LucidStore
    const namedRows = await namedStore.query({ stream: 'read-options' })
    assert.lengthOf(namedRows, 1)
    const namedHead = await namedStore.head('read-options')
    assert.equal(namedHead?.seq, 1)

    const db = await app.container.make('lucid.db')
    await db.transaction(async (transaction) => {
      const transactionRows = await store.query({ stream: 'read-options' }, { client: transaction })
      const transactionHead = await store.head('read-options', { client: transaction })
      assert.equal(transactionHead?.seq, 1)
      assert.lengthOf(transactionRows, 1)
    })
  })

  test('inTenant scopes by tenantId', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ tenantId: 'acme' })])
    await store.write([makeEvent({ tenantId: 'globex' })])

    const rows = await Audit.query().apply((scopes) => scopes.inTenant('acme'))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].tenantId, 'acme')
  })

  test('event scope filters by event name', async ({ assert }) => {
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ event: 'user.created' })])
    await store.write([makeEvent({ event: 'user.deleted' })])

    const rows = await Audit.query().apply((scopes) => scopes.event('user.created'))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].event, 'user.created')
  })
})
