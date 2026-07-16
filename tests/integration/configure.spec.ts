import { AppFactory } from '@adonisjs/application/factories'
import { test } from '@japa/runner'
import { configure } from '../../configure.js'
import { stubsRoot } from '../../stubs/main.js'

type StubCall = {
  root: string
  path: string
  data: Record<string, unknown>
}

async function renderAuditConfig(data: Record<string, unknown>) {
  const app = new AppFactory().create(new URL('../../', import.meta.url))
  await app.init()
  const stubs = await app.stubs.create()
  const stub = await stubs.build('config/audit.stub', { source: stubsRoot })
  const prepared = await stub.prepare(data)
  return prepared.contents
}

test.group('Configure hook', () => {
  test('prompts for options and wires all codemods', async ({ assert }) => {
    const calls: {
      makeUsingStub: StubCall[]
      updateRcFile: unknown[]
      registerMiddleware: unknown[]
      defineEnvValidations: unknown[]
      renderedConfig?: string
    } = {
      makeUsingStub: [],
      updateRcFile: [],
      registerMiddleware: [],
      defineEnvValidations: [],
    }

    const codemods = {
      async makeUsingStub(root: string, path: string, data: Record<string, unknown>) {
        calls.makeUsingStub.push({ root, path, data })
        if (path === 'config/audit.stub') {
          calls.renderedConfig = await renderAuditConfig(data)
        }
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
      parsedFlags: {},
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
        data: {
          auditConnection: undefined,
          auditTable: 'audits',
          multiTenant: false,
          outbox: false,
          outboxConnection: undefined,
          outboxTable: 'audit_outbox',
        },
      },
      {
        root: stubsRoot,
        path: 'migrations/create_audits_table.stub',
        data: { auditConnection: undefined, auditTable: 'audits', immutability: true },
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

    const configCall = calls.makeUsingStub.find((call) => call.path === 'config/audit.stub')
    assert.isDefined(configCall, 'config stub published')
    assert.equal(
      configCall!.data.outbox,
      false,
      'default config selects automatic auth-event capture'
    )
    assert.match(calls.renderedConfig!, /captureAuthEvents:\s*true/)
  })

  test('configures outbox scaffolding without automatic auth-event capture', async ({ assert }) => {
    const calls: { makeUsingStub: StubCall[]; renderedConfig?: string } = { makeUsingStub: [] }

    const codemods = {
      async makeUsingStub(root: string, path: string, data: Record<string, unknown>) {
        calls.makeUsingStub.push({ root, path, data })
        if (path === 'config/audit.stub') {
          calls.renderedConfig = await renderAuditConfig(data)
        }
        return { destination: path }
      },
      async updateRcFile() {},
      async registerMiddleware() {},
      async defineEnvValidations() {},
    }

    const command = {
      parsedFlags: {},
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

    assert.isTrue(
      calls.makeUsingStub.some((call) => call.path === 'migrations/create_audit_outbox_table.stub')
    )
    const configCall = calls.makeUsingStub.find((call) => call.path === 'config/audit.stub')
    assert.isDefined(configCall, 'config stub published')
    assert.equal(
      configCall!.data.outbox,
      true,
      'outbox config selects disabled automatic auth-event capture'
    )
    assert.match(calls.renderedConfig!, /guarantee:\s*'transactional-outbox'/)
    assert.match(calls.renderedConfig!, /captureAuthEvents:\s*false/)
  })

  test('uses CLI flags without prompting', async ({ assert }) => {
    const calls: { makeUsingStub: StubCall[]; updateRcFile: unknown[] } = {
      makeUsingStub: [],
      updateRcFile: [],
    }
    let prompted = false

    const codemods = {
      async makeUsingStub(root: string, path: string, data: Record<string, unknown>) {
        calls.makeUsingStub.push({ root, path, data })
        return { destination: path }
      },
      async updateRcFile(callback: (rc: any) => void) {
        callback({
          addProvider: () => {},
          addCommand: () => {},
        })
      },
      async registerMiddleware() {},
      async defineEnvValidations() {},
    }

    const command = {
      parsedFlags: {
        'audit-connection': 'audit',
        'audit-table': 'audit_log',
        'immutability': false,
        'multi-tenant': false,
        'outbox': true,
        'outbox-connection': 'primary',
        'outbox-table': 'audit_outbox',
      },
      prompt: {
        confirm: async () => {
          prompted = true
          return false
        },
      },
      async createCodemods() {
        return codemods as any
      },
      logger: {
        success() {},
      },
    }

    await configure(command as any)

    assert.isFalse(prompted, 'no prompts when all flags provided')
    assert.isTrue(
      calls.makeUsingStub.some((call) => call.path === 'migrations/create_audit_outbox_table.stub'),
      'outbox migration published when --outbox flag is true'
    )
    const configCall = calls.makeUsingStub.find((call) => call.path === 'config/audit.stub')
    assert.isDefined(configCall, 'config stub published')
    assert.equal(configCall!.data.outbox, true, 'outbox flag flows to config stub')
    assert.equal(
      configCall!.data.auditConnection,
      'audit',
      'target connection flows to config stub'
    )
    assert.equal(configCall!.data.auditTable, 'audit_log', 'target table flows to config stub')
    assert.equal(
      configCall!.data.outboxConnection,
      'primary',
      'source connection flows to config stub'
    )
    assert.equal(configCall!.data.outboxTable, 'audit_outbox', 'source table flows to config stub')
  })
})
