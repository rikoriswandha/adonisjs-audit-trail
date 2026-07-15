import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { Kernel } from '@adonisjs/core/ace'
import type { BaseCommand } from '@adonisjs/core/ace'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import Audit from '../../src/models/audit.js'
import type AuditService from '../../src/services/audit.js'
import type { RetentionSegment } from '../../src/types.js'
import { auditContext } from '../../src/audit_context.js'
import AuditStats from '../../commands/audit_stats.js'
import AuditVerify from '../../commands/audit_verify.js'
import AuditPrune from '../../commands/audit_prune.js'
import AuditReplayOutbox from '../../commands/audit_replay_outbox.js'
import AuditForget from '../../commands/audit_forget.js'
import { fileAppendPublisher } from '../../src/core/anchor.js'
import { MemorySubjectKeyStore } from '../../src/core/subject_crypto.js'

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
async function createCommandApp(dialect: string = 'sqlite', auditConfig = {}) {
  const app = await createTestApp(
    {
      default: 'lucid',
      ...auditConfig,
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

async function seedCorruptedRows(app: ApplicationService) {
  const audit = (await app.container.make('audit')) as AuditService
  await audit.log('user.login').commitSync()
  const row = await Audit.query().orderBy('seq', 'asc').firstOrFail()
  const db = await app.container.make('lucid.db')
  await db
    .connection()
    .query()
    .from('audits')
    .where('id', row.id)
    .update({ hash: '0'.repeat(64) })
}

function parseCommandArgv(argv: string[]): { args: string[]; flags: Record<string, unknown> } {
  const flags: Record<string, unknown> = {}
  const args: string[] = []

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=')
      flags[key] = valueParts.length > 0 ? valueParts.join('=') : true
    } else {
      args.push(arg)
    }
  }

  return { args, flags }
}
async function runCommand(
  app: ApplicationService,
  CommandClass: new (...args: any[]) => BaseCommand,
  argv: string[] = []
) {
  const parsed = parseCommandArgv(argv)
  const kernel = Kernel.create()
  const command = new (CommandClass as any)(
    app,
    kernel,
    { args: parsed.args, flags: parsed.flags },
    kernel.ui,
    kernel.prompt
  ) as BaseCommand & {
    app: ApplicationService
    exitCode?: number
    hydrate: () => void
  }
  command.hydrate()
  await command.run()
  return command
}

withDatabases('Audit commands', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createCommandApp(dialect)
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

  test('audit:verify --check-anchors matches anchor file', async ({ assert }) => {
    const anchorsFile = join(mkdtempSync(join(tmpdir(), 'audit-anchor-')), 'anchors.ndjson')
    const publish = await fileAppendPublisher(anchorsFile)

    app = await createCommandApp(dialect, {
      chain: {
        anchor: { every: 1, publish, anchorsFile },
      },
    })
    await runMigrations(app)

    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('user.login').commitSync()

    for (let i = 0; i < 50; i++) {
      if (existsSync(anchorsFile)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const command = await runCommand(app, AuditVerify, ['--check-anchors'])
    assert.equal(command.exitCode, 0)
  })

  test('audit:verify detects a mismatched older anchor even when the current head differs', async ({
    assert,
  }) => {
    const anchorsFile = join(mkdtempSync(join(tmpdir(), 'audit-anchor-')), 'anchors.ndjson')
    writeFileSync(
      anchorsFile,
      `${JSON.stringify({ stream: 'default', seq: 1, hash: '0'.repeat(64) })}\n`
    )
    await cleanupTestApp(app)
    app = await createCommandApp(dialect, {
      chain: {
        anchor: {
          every: 1,
          publish: async () => {},
          anchorsFile,
        },
      },
    })
    await runMigrations(app)

    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('user.login').commitSync()
    await audit.log('user.logout').commitSync()

    const command = await runCommand(app, AuditVerify, ['--check-anchors'])
    assert.notEqual(command.exitCode, 0)
  })

  test('audit:forget deletes subject key', async ({ assert }) => {
    const keyStore = new MemorySubjectKeyStore()
    app = await createCommandApp(dialect, {
      cryptoShredding: {
        enabled: true,
        fields: ['email'],
        keyStore,
      },
    })
    await runMigrations(app)

    const audit = (await app.container.make('audit')) as AuditService
    await auditContext.run({ actor: { type: 'user', id: 'user-1' } }, async () => {
      await audit.log('user.created').withNew({ email: 'ada@example.com' }).commitSync()
    })

    const command = await runCommand(app, AuditForget, ['--subject=user-1'])
    assert.equal(command.exitCode, 0)

    const storedKey = await keyStore.get('user-1')
    assert.isNull(storedKey)
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

  test('audit:prune archives segments before deleting old rows', async ({ assert }) => {
    const archived: unknown[] = []
    await cleanupTestApp(app)
    app = await createCommandApp(dialect, {
      retention: {
        default: '1 day',
        archive: async (segment: RetentionSegment) => {
          archived.push(segment)
        },
      },
    })

    const audit = (await app.container.make('audit')) as AuditService
    await audit.log('old.event').commitSync()
    await audit.log('new.event').commitSync()

    const db = await app.container.make('lucid.db')
    await db
      .connection()
      .query()
      .from('audits')
      .where('event', 'old.event')
      .update({ created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })

    const command = await runCommand(app, AuditPrune)

    assert.equal(command.exitCode, 0)
    assert.lengthOf(archived, 1)
    assert.isNull(await Audit.query().where('event', 'old.event').first())
    assert.isNotNull(await Audit.query().where('event', 'new.event').first())
  })

  test('audit:replay-outbox drains pending rows', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    await db
      .connection()
      .table('audit_outbox')
      .insert({
        id: crypto.randomUUID(),
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
        tenant_id: null,
        status: 'pending',
        attempts: 0,
        available_at: new Date(),
        created_at: new Date(),
      })

    const command = await runCommand(app, AuditReplayOutbox)
    assert.equal(command.exitCode, 0)
    const auditRow = await Audit.query().where('event', 'outbox.event').first()
    assert.isNotNull(auditRow)
  })
})
