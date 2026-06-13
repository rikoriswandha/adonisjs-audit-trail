import { test } from '@japa/runner'
import { configure } from '../../configure.js'
import { stubsRoot } from '../../stubs/main.js'

test.group('Configure hook', () => {
  test('prompts for options and wires all codemods', async ({ assert }) => {
    const calls: Record<string, unknown[]> = {
      makeUsingStub: [],
      updateRcFile: [],
      registerMiddleware: [],
      defineEnvValidations: [],
    }

    const codemods = {
      async makeUsingStub(root: string, path: string, data: Record<string, unknown>) {
        calls.makeUsingStub.push({ root, path, data })
        return { destination: path }
      },
      async updateRcFile(callback: (rc: any) => void) {
        const rc = {
          addProvider: (path: string) => calls.updateRcFile.push({ type: 'provider', path }),
          addCommand: (path: string) => calls.updateRcFile.push({ type: 'command', path }),
        }
        callback(rc)
      },
      async registerMiddleware(stack: string, middleware: any[]) {
        calls.registerMiddleware.push({ stack, middleware })
      },
      async defineEnvValidations(validations: any) {
        calls.defineEnvValidations.push(validations)
      },
    }

    const command = {
      prompt: {
        confirm: async (_message: string, options?: { default?: boolean }) =>
          options?.default ?? false,
      },
      async createCodemods() {
        return codemods as any
      },
      logger: {
        success(_message: string) {},
      },
    }

    await configure(command as any)

    assert.deepEqual(calls.makeUsingStub, [
      {
        root: stubsRoot,
        path: 'config/audit.stub',
        data: { outbox: false, multiTenant: false, immutability: true },
      },
      {
        root: stubsRoot,
        path: 'migrations/create_audits_table.stub',
        data: { immutability: true, multiTenant: false },
      },
      { root: stubsRoot, path: 'transformers/audit_transformer.stub', data: {} },
      { root: stubsRoot, path: 'start/audit_events.stub', data: {} },
    ])

    assert.deepInclude(calls.updateRcFile, {
      type: 'provider',
      path: '@rikology/adonisjs-audit-trail/audit_provider',
    })
    assert.deepInclude(calls.updateRcFile, {
      type: 'command',
      path: '@rikology/adonisjs-audit-trail/commands',
    })

    assert.deepEqual(calls.registerMiddleware, [
      {
        stack: 'router',
        middleware: [{ path: '@rikology/adonisjs-audit-trail/audit_context_middleware' }],
      },
    ])

    assert.deepEqual(calls.defineEnvValidations, [
      {
        variables: { AUDIT_REDACTION_SALT: 'Env.schema.string.optional()' },
        leadingComment: 'Variables for @rikology/adonisjs-audit-trail',
      },
    ])
  })

  test('publishes outbox migration when outbox is enabled', async ({ assert }) => {
    const stubs: string[] = []

    const codemods = {
      async makeUsingStub(_root: string, path: string, _data: Record<string, unknown>) {
        stubs.push(path)
        return { destination: path }
      },
      async updateRcFile() {},
      async registerMiddleware() {},
      async defineEnvValidations() {},
    }

    const command = {
      prompt: {
        confirm: async () => true,
      },
      async createCodemods() {
        return codemods as any
      },
      logger: {
        success() {},
      },
    }

    await configure(command as any)

    assert.include(stubs, 'migrations/create_audit_outbox_table.stub')
    assert.include(stubs, 'config/audit.stub')
  })
})
