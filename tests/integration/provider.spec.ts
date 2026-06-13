import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
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

test.group('AuditProvider', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('container resolves audit.manager, pipeline and facade', async ({ assert }) => {
    const manager = await app.container.make('audit.manager')
    const pipeline = await app.container.make('audit.pipeline')
    const audit = await app.container.make('audit')

    assert.isDefined(manager)
    assert.isDefined(pipeline)
    assert.isDefined(audit)
  })

  test('facade emits and flushes to lucid store', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService

    await auditContext.run(
      {
        actor: { type: 'user', id: '1' },
        ip: '127.0.0.1',
        requestId: 'r1',
      },
      async () => {
        await audit.log('post.created').withNew({ title: 'Hello' }).commitSync()
      }
    )

    const row = await Audit.query().where('event', 'post.created').first()
    assert.isNotNull(row)
    assert.equal(row!.event, 'post.created')
    assert.equal(row!.actorType, 'user')
    assert.equal(row!.ipAddress, '127.0.0.1')
    assert.equal(row!.seq, 1)
    assert.lengthOf(row!.hash, 64)
    assert.lengthOf(row!.prevHash, 64)
  })

  test('provider pipeline applies configured redaction before writing', async ({ assert }) => {
    await cleanupTestApp(app)
    app = await createTestApp({
      default: 'lucid',
      redaction: { global: ['password'], mode: 'mask' },
      stores: {
        lucid: async (application: ApplicationService) => {
          const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
          return new LucidStore(application, {})
        },
      },
    })
    await runMigrations(app)

    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('user.updated').withNew({ password: 'secret' }).commitSync()

    const row = await Audit.query().where('event', 'user.updated').firstOrFail()
    assert.deepEqual(row.newValues, { password: '[REDACTED]' })
  })

  test('shutdown flushes pending events', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService
    const pipeline = await app.container.make('audit.pipeline')

    await auditContext.run(
      {
        actor: { type: 'user', id: '2' },
        ip: '127.0.0.1',
        requestId: 'r2',
      },
      async () => {
        await audit.log('post.updated').withNew({ title: 'Pending' }).commit()
      }
    )

    await app.terminate()
    assert.equal(pipeline.stats().written, 1)

    app = await createLucidApp()
  })
})
