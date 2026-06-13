import { test } from '@japa/runner'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditableModelConfig } from '../../src/types.js'
import { DateTime } from 'luxon'
import { auditContext } from '../../src/audit_context.js'
import { Auditable } from '../../src/mixins/auditable.js'
import Audit from '../../src/models/audit.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'
import { Post } from '../helpers/models.js'

class JsonPost extends Auditable(BaseModel) {
  static table = 'json_posts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column()
  declare payload: Record<string, unknown>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}

class RedactedPost extends Auditable(BaseModel) {
  static table = 'posts'
  static auditConfig: AuditableModelConfig = {
    exclude: ['updatedAt'],
    redact: ['body'],
    tags: ['posts'],
  }

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column()
  declare body: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}

class SoftPost extends Auditable(BaseModel) {
  static table = 'soft_posts'
  static auditConfig: AuditableModelConfig = {
    events: ['created', 'updated', 'deleted', 'restored'],
  }

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare title: string

  @column.dateTime()
  declare deletedAt: DateTime | null
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
  await migrateExtraTables(app)
  return app
}

async function migrateExtraTables(app: ApplicationService): Promise<void> {
  const db = await app.container.make('lucid.db')
  const client = db.connection()

  if (!(await client.schema.hasTable('json_posts'))) {
    await client.schema.createTable('json_posts', (table) => {
      table.increments('id')
      table.string('title').notNullable()
      table.json('payload').notNullable()
      table.timestamp('created_at').notNullable()
    })
  }

  if (!(await client.schema.hasTable('soft_posts'))) {
    await client.schema.createTable('soft_posts', (table) => {
      table.increments('id')
      table.string('title').notNullable()
      table.timestamp('deleted_at').nullable()
    })
  }
}

async function waitForAudits(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await Audit.query()
    if (rows.length >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

withDatabases('Auditable mixin', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp(dialect)
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('creates an actor and request-scoped audit row for model create', async ({ assert }) => {
    let post!: Post
    await auditContext.run(
      {
        actor: { type: 'user', id: '42', label: 'Ada' },
        requestId: 'req-1',
        ip: '127.0.0.1',
        userAgent: 'Japa',
        url: '/posts',
        httpMethod: 'POST',
      },
      async () => {
        post = await Post.create({ title: 'Hello', body: 'World' })
      }
    )

    await waitForAudits(1)
    const row = await Audit.query().where('event', 'model.created').firstOrFail()
    const relatedRows = await (post as Post & { audits: () => Promise<Audit[]> }).audits()

    assert.equal(row.actorType, 'user')
    assert.equal(row.actorId, '42')
    assert.equal(row.requestId, 'req-1')
    assert.equal(row.ipAddress, '127.0.0.1')
    assert.equal(row.auditableType, 'Post')
    assert.equal(row.newValues?.title, 'Hello')
    assert.isString(row.newValues?.createdAt)
    assert.isNull(row.oldValues)
    assert.lengthOf(relatedRows, 1)
    assert.lengthOf(row.hash, 64)
  })

  test('updates only dirty attributes and suppresses empty diffs after exclude', async ({
    assert,
  }) => {
    const post = await RedactedPost.createQuietly({ title: 'Old', body: 'Secret' })

    post.title = 'New'
    post.body = 'Still secret'
    await post.save()
    await waitForAudits(1)

    const row = await Audit.query().where('event', 'model.updated').firstOrFail()
    assert.deepEqual(row.oldValues, { title: 'Old', body: '[REDACTED]' })
    assert.deepEqual(row.newValues, { title: 'New', body: '[REDACTED]' })
    assert.deepEqual(row.tags, ['posts'])

    const beforeRows = await Audit.query()
    const countBefore = beforeRows.length
    await post.save()
    await waitForAudits(countBefore)
    const afterRows = await Audit.query()
    assert.lengthOf(afterRows, countBefore)
  })

  test('serializes JSON attributes and excludes extras', async ({ assert }) => {
    const post = await JsonPost.create({ title: 'Json', payload: { nested: { ok: true } } })
    post.$extras.secret = 'ignored'

    await waitForAudits(1)
    const row = await Audit.query().where('auditable_type', 'JsonPost').firstOrFail()

    assert.deepEqual(row.newValues?.payload, { nested: { ok: true } })
    assert.notProperty(row.newValues!, 'secret')
  })

  test('captures deletes and restore-style deletedAt transitions', async ({ assert }) => {
    const post = await SoftPost.createQuietly({ title: 'Soft', deletedAt: DateTime.utc() })

    post.deletedAt = null
    await post.save()
    await waitForAudits(1)

    const restored = await Audit.query().where('event', 'model.restored').firstOrFail()
    assert.isNotNull(restored.oldValues?.deletedAt)
    assert.isNull(restored.newValues?.deletedAt)

    await post.delete()
    await waitForAudits(2)
    const deleted = await Audit.query().where('event', 'model.deleted').firstOrFail()
    assert.equal(deleted.oldValues?.title, 'Soft')
    assert.isNull(deleted.newValues)
  })
})
