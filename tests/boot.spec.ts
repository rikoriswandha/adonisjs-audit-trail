import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from './helpers/app.js'
import { runMigrations } from './helpers/migrate.js'
import { Post } from './helpers/models.js'

test.group('Boot', (group) => {
  let app: ApplicationService

  group.setup(async () => {
    app = await createTestApp()
    await runMigrations(app)
  })

  group.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('app boots and resolves audit.manager from container', async ({ assert }) => {
    const manager = await app.container.make('audit.manager')
    assert.isDefined(manager)
  })

  test('app boots and resolves audit facade from container', async ({ assert }) => {
    const audit = await app.container.make('audit')
    assert.isDefined(audit)
  })

  test('test migrations create audit and model tables', async ({ assert }) => {
    const db = await app.container.make('lucid.db')
    const client = db.connection()

    assert.isTrue(await client.schema.hasTable('audits'))
    assert.isTrue(await client.schema.hasTable('audit_outbox'))
    assert.isTrue(await client.schema.hasTable('posts'))
  })

  test('test Post helper model writes through Lucid', async ({ assert }) => {
    const post = await Post.create({ title: 'M0 smoke', body: null })

    assert.isNumber(post.id)
    assert.equal(post.title, 'M0 smoke')
  })
})
