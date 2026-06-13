import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import Audit from '../../src/models/audit.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'

type TestEmitter = {
  emit(event: string, payload: unknown): Promise<void>
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

async function waitForAudits(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await Audit.query()
    const count = rows.length
    if (count >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test.group('Auth listener', (group) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp()
  })

  group.each.teardown(async () => {
    await cleanupTestApp(app)
  })

  test('records session login events from auth emitter payloads', async ({ assert }) => {
    const emitter = (await app.container.make('emitter')) as unknown as TestEmitter

    await emitter.emit('session_auth:login_succeeded', {
      guardName: 'web',
      sessionId: 'session-1',
      user: { id: 123, email: 'ada@example.com' },
    })

    await waitForAudits(1)
    const row = await Audit.query().where('event', 'auth.login').firstOrFail()
    assert.equal(row.actorType, 'user')
    assert.equal(row.actorId, '123')
    assert.equal(row.actorLabel, 'ada@example.com')
    assert.deepEqual(row.metadata, { guardName: 'web', sessionId: 'session-1' })
  })

  test('records failed login attempted identifier for redaction pipeline', async ({ assert }) => {
    const emitter = (await app.container.make('emitter')) as unknown as TestEmitter

    await emitter.emit('session_auth:authentication_failed', {
      guardName: 'web',
      error: new Error('Bad credentials'),
      ctx: {
        request: {
          input: (key: string) => (key === 'email' ? 'ada@example.com' : null),
        },
      },
    })

    await waitForAudits(1)
    const row = await Audit.query().where('event', 'auth.login_failed').firstOrFail()
    assert.equal(row.metadata?.attemptedIdentifier, 'ada@example.com')
    assert.equal(row.metadata?.error, 'Bad credentials')
  })
})
