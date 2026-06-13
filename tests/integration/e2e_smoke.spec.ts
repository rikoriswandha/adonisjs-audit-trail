import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { Post } from '../helpers/models.js'
import Audit from '../../src/models/audit.js'
import type AuditService from '../../src/services/audit.js'
import { auditContext } from '../../src/audit_context.js'

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

test.group('E2E smoke', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('log builder emits chained audit row', async ({ assert }) => {
    const post = await Post.create({ title: 'Hello', body: 'World' })
    const audit = (await app.container.make('audit')) as AuditService

    await auditContext.run(
      {
        actor: { type: 'user', id: '1' },
        ip: '127.0.0.1',
        requestId: 'r1',
      },
      async () => {
        await audit.log('post.created').on(post).commitSync()
      }
    )

    const row = await Audit.query().where('event', 'post.created').first()
    assert.isNotNull(row)
    assert.equal(row!.event, 'post.created')
    assert.equal(row!.auditableType, 'Post')
    assert.equal(row!.auditableId, String(post.id))
    assert.equal(row!.actorType, 'user')
    assert.equal(row!.ipAddress, '127.0.0.1')
    assert.equal(row!.seq, 1)
    assert.lengthOf(row!.hash, 64)
    assert.lengthOf(row!.prevHash, 64)
  })

  test('concurrent events chain independently by stream', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService

    await auditContext.run(
      {
        actor: { type: 'user', id: '2' },
        tenantId: 'acme',
      },
      async () => {
        await Promise.all([
          audit.log('user.login').commitSync(),
          audit.log('user.login').commitSync(),
        ])
      }
    )

    const rows = await Audit.query().where('event', 'user.login').orderBy('seq', 'asc')
    assert.lengthOf(rows, 2)
    assert.equal(rows[0].seq, 1)
    assert.equal(rows[1].seq, 2)
    assert.equal(rows[1].prevHash, rows[0].hash)
  })
})
