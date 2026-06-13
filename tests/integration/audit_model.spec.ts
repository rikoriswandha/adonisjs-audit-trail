import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { Post } from '../helpers/models.js'
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

test.group('Audit model scopes', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('forModel scopes by type and id', async ({ assert }) => {
    const post = await Post.create({ title: 'Hello', body: null })
    const store = useStore(await app.container.make('audit.manager'))
    await store.write([makeEvent({ auditableType: 'Post', auditableId: String(post.id) })])
    await store.write([makeEvent({ auditableType: 'Post', auditableId: '999' })])

    const rows = await Audit.query().apply((scopes) => scopes.forModel(post))
    assert.lengthOf(rows, 1)
    assert.equal(rows[0].auditableId, String(post.id))
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
