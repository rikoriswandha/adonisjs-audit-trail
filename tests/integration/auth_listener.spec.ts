import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditConfig } from '../../src/types.js'
import type { DbDialect } from '../helpers/dialect.js'
import Audit from '../../src/models/audit.js'
import LucidStore from '../../src/stores/lucid_store.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import { runMigrations } from '../helpers/migrate.js'
import { withDatabases } from '../helpers/matrix.js'

type TestEmitter = {
  emit(event: string, payload: unknown): Promise<void>
}

async function createLucidApp(
  dialect: DbDialect = 'sqlite',
  auditConfig: Partial<AuditConfig> = {}
) {
  const app = await createTestApp(
    {
      ...auditConfig,
      default: 'lucid',
      stores: {
        lucid: async (application: ApplicationService) => {
          return new LucidStore(application, {})
        },
      },
    },
    dialect
  )
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

withDatabases('Auth listener', (group, dialect) => {
  let app: ApplicationService

  group.each.setup(async () => {
    app = await createLucidApp(dialect)
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

  test('does not attach automatic auth capture in transactional-outbox mode', async ({
    assert,
  }) => {
    const outboxApp = await createLucidApp(dialect, { guarantee: 'transactional-outbox' })

    try {
      const emitter = (await outboxApp.container.make('emitter')) as unknown as TestEmitter

      await assert.doesNotReject(() =>
        emitter.emit('session_auth:login_succeeded', {
          guardName: 'web',
          sessionId: 'session-1',
          user: { id: 123, email: 'ada@example.com' },
        })
      )
      await assert.doesNotReject(() =>
        emitter.emit('session_auth:logged_out', {
          guardName: 'web',
          sessionId: 'session-1',
          user: { id: 123, email: 'ada@example.com' },
        })
      )
      await assert.doesNotReject(() =>
        emitter.emit('session_auth:authentication_failed', {
          guardName: 'web',
          error: new Error('Bad credentials'),
          ctx: {
            request: {
              input: (key: string) => (key === 'email' ? 'ada@example.com' : null),
            },
          },
        })
      )

      const db = await outboxApp.container.make('lucid.db')
      const [outboxRows, auditRows] = await Promise.all([
        db.connection().query().from('audit_outbox'),
        db.connection().query().from('audits'),
      ])

      assert.lengthOf(outboxRows, 0, 'auth events did not create outbox intent rows')
      assert.lengthOf(auditRows, 0, 'auth events did not create audit rows')
    } finally {
      await cleanupTestApp(outboxApp)
    }
  })
})
