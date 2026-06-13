import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { Kernel } from '@adonisjs/core/ace'
import type { BaseCommand } from '@adonisjs/core/ace'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import Audit from '../../src/models/audit.js'
import type AuditService from '../../src/services/audit.js'
import AuditStats from '../../commands/audit_stats.js'
import AuditVerify from '../../commands/audit_verify.js'
import AuditPrune from '../../commands/audit_prune.js'
import AuditReplayOutbox from '../../commands/audit_replay_outbox.js'

async function createCommandApp(auditConfig = {}) {
  const app = await createTestApp({
    default: 'lucid',
    ...auditConfig,
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

async function seedCorruptedRows(app: ApplicationService) {
  const audit = (await app.container.make('audit')) as AuditService
  await audit.log('user.login').commitSync()
  const row = await Audit.query().orderBy('seq', 'asc').firstOrFail()
  const db = await app.container.make('lucid.db')
  await db.rawQuery(
    "UPDATE audits SET hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = ?",
    [row.id]
  )
}

async function runCommand(
  app: ApplicationService,
  CommandClass: typeof BaseCommand,
  argv: string[] = []
) {
  const kernel = Kernel.create()
  const command = new (CommandClass as any)(
    app,
    kernel,
    { args: argv, flags: {} },
    kernel.ui,
    kernel.prompt
  ) as BaseCommand & { app: ApplicationService; exitCode?: number }
  await command.run()
  return command
}

test.group('Audit commands', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createCommandApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('audit:stats returns zero exit code', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('user.login').commitSync()

    const command = await runCommand(app, AuditStats)
    assert.equal(command.exitCode, 0)
  })

  test('audit:verify passes on a clean chain', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('user.login').commitSync()

    const command = await runCommand(app, AuditVerify)
    assert.equal(command.exitCode, 0)
  })

  test('audit:verify exits non-zero on a corrupted chain', async ({ assert }) => {
    await seedCorruptedRows(app)

    const command = await runCommand(app, AuditVerify)
    assert.notEqual(command.exitCode, 0)
  })

  test('audit:prune dry-run counts without deleting', async ({ assert }) => {
    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('old.event').commitSync()

    const beforeCount = await Audit.query().count('* as count')
    const command = await runCommand(app, AuditPrune, ['--dry-run'])
    const afterCount = await Audit.query().count('* as count')

    assert.equal(command.exitCode, 0)
    assert.equal(beforeCount[0].$extras.count, afterCount[0].$extras.count)
  })

  test('audit:replay-outbox drains pending rows', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    await db.table('audit_outbox').insert({
      payload: JSON.stringify({
        id: crypto.randomUUID(),
        event: 'outbox.event',
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
      }),
      attempts: 0,
      created_at: new Date().toISOString(),
    })

    const command = await runCommand(app, AuditReplayOutbox)
    assert.equal(command.exitCode, 0)
    const auditRow = await Audit.query().where('event', 'outbox.event').first()
    assert.isNotNull(auditRow)
  })
})
