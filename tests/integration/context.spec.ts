import { test } from '@japa/runner'
import { auditContext } from '../../src/audit_context.js'
import type { AuditActor } from '../../src/types.js'
import AuditContextMiddleware from '../../src/middleware/audit_context_middleware.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'
import type { HttpContext } from '@adonisjs/core/http'

test.group('AuditContext', () => {
  test('run stores and get retrieves actor', async ({ assert }) => {
    const actor: AuditActor = { type: 'user', id: '1' }
    await auditContext.run({ actor }, async () => {
      assert.deepEqual(auditContext.get()?.actor, actor)
    })
  })

  test('lazy actor resolver is resolved at read time', async ({ assert }) => {
    const actor: AuditActor = { type: 'user', id: '2' }
    await auditContext.run(
      {
        actor: async () => actor,
      },
      async () => {
        const store = auditContext.get()
        assert.isFunction(store?.actor)
        const resolved = await (store?.actor as () => Promise<AuditActor>)()
        assert.deepEqual(resolved, actor)
      }
    )
  })

  test('nested contexts override and restore outer', async ({ assert }) => {
    await auditContext.run({ requestId: 'outer' }, async () => {
      assert.equal(auditContext.get()?.requestId, 'outer')

      await auditContext.run({ requestId: 'inner' }, async () => {
        assert.equal(auditContext.get()?.requestId, 'inner')
      })

      assert.equal(auditContext.get()?.requestId, 'outer')
    })
  })

  test('set patches current store', async ({ assert }) => {
    await auditContext.run({ requestId: 'before' }, async () => {
      auditContext.set({ tenantId: 'acme' })
      assert.equal(auditContext.get()?.requestId, 'before')
      assert.equal(auditContext.get()?.tenantId, 'acme')
    })
  })

  test('middleware stores tenant from configured resolver', async ({ assert }) => {
    const app = await createTestApp({
      tenantResolver: () => 'tenant-1',
    })

    try {
      const middleware = new AuditContextMiddleware(app)
      const ctx = {
        request: {
          id: () => 'request-1',
          ip: () => '127.0.0.1',
          header: () => undefined,
          url: () => '/posts',
          method: () => 'GET',
        },
      } as unknown as HttpContext

      await middleware.handle(ctx, async () => {
        assert.equal(auditContext.get()?.tenantId, 'tenant-1')
      })
    } finally {
      await cleanupTestApp(app)
    }
  })

  test('get returns undefined outside context', async ({ assert }) => {
    assert.isUndefined(auditContext.get())
  })
})
