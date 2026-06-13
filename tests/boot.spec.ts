import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import { createTestApp, cleanupTestApp } from './helpers/app.js'

test.group('Boot', (group) => {
  let app: ApplicationService

  group.setup(async () => {
    app = await createTestApp()
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
})
