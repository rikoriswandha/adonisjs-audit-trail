import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { auditContext } from '../../src/audit_context.js'
import Audit from '../../src/models/audit.js'
import type AuditService from '../../src/services/audit.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import { Post } from '../helpers/models.js'

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

withDatabases('Domain events', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp(dialect)
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('builder commits refs, actor, metadata, old/new values and tags', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService

    await audit
      .log('invoice.approved')
      .onRef('Invoice', 'inv-1')
      .by({ type: 'user', id: '7', label: 'Grace' })
      .withOld({ status: 'pending' })
      .withNew({ status: 'approved' })
      .withMeta({ approvalLevel: 2 })
      .tag('billing', 'approval')
      .commitSync()

    const row = await Audit.query().where('event', 'invoice.approved').firstOrFail()
    assert.equal(row.auditableType, 'Invoice')
    assert.equal(row.auditableId, 'inv-1')
    assert.equal(row.actorType, 'user')
    assert.equal(row.actorId, '7')
    assert.equal(row.actorLabel, 'Grace')
    assert.deepEqual(row.oldValues, { status: 'pending' })
    assert.deepEqual(row.newValues, { status: 'approved' })
    assert.deepEqual(row.metadata, { approvalLevel: 2 })
    assert.deepEqual(row.tags, ['billing', 'approval'])
  })

  test('commitSync waits until the row is queryable and uses ALS fallback actor', async ({
    assert,
  }) => {
    const audit = (await app.container.make('audit')) as AuditService
    const post = await Post.createQuietly({ title: 'Domain', body: null })

    await auditContext.run(
      {
        actor: { type: 'user', id: '9' },
        requestId: 'domain-req',
      },
      async () => {
        await audit.log('post.exported').on(post).withMeta({ format: 'csv' }).commitSync()
      }
    )

    const row = await Audit.query().where('event', 'post.exported').firstOrFail()
    assert.equal(row.actorId, '9')
    assert.equal(row.requestId, 'domain-req')
    assert.equal(row.metadata?.format, 'csv')
  })
})
