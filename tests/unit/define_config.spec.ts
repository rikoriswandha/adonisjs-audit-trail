import { test } from '@japa/runner'
import { configProvider } from '@adonisjs/core'
import type { ConfigProvider } from '@adonisjs/core/types'
import type { ApplicationService } from '@adonisjs/core/types'
import { defineConfig, stores } from '../../src/define_config.js'
import type { ResolvedAuditConfig } from '../../src/define_config.js'
import type {
  AuditStoreContract,
  AuditStoreFactory,
  AuditStoreResolvedConfig,
} from '../../src/types.js'
import { createTestApp, cleanupTestApp } from '../helpers/app.js'

const memoryStore = function (): AuditStoreContract {
  return {
    write: async () => [],
    head: async () => null,
    verify: async function* () {},
    prune: async () => ({ streams: [], totalPruned: 0, perEvent: {} }),
  }
}

const memoryFactory: AuditStoreFactory = async function () {
  return memoryStore()
}

test.group('defineConfig', function (group) {
  let app: ApplicationService

  group.setup(async function () {
    app = await createTestApp()
  })

  group.teardown(async function () {
    await cleanupTestApp(app)
  })

  test('resolves direct store factories', async function ({ assert, expectTypeOf }) {
    const provider = defineConfig({
      stores: {
        memory: memoryFactory,
      },
    })

    const resolved = (await configProvider.resolve(app, provider)) as ResolvedAuditConfig<{
      memory: typeof memoryFactory
    }>

    assert.isDefined(resolved.stores.memory)
    expectTypeOf(resolved.stores.memory).toEqualTypeOf<AuditStoreContract>()
  })

  test('resolves config providers for stores', async function ({ assert }) {
    const provider = defineConfig({
      stores: {
        memory: configProvider.create(async function () {
          return { type: 'memory' }
        }),
      },
    })

    const resolved = (await configProvider.resolve(app, provider)) as ResolvedAuditConfig<{
      memory: ConfigProvider<AuditStoreResolvedConfig>
    }>

    assert.deepEqual(resolved.stores.memory, { type: 'memory' })
  })

  test('applies default values', async function ({ assert }) {
    const provider = defineConfig({
      stores: {
        memory: memoryFactory,
      },
    })

    const resolved = (await configProvider.resolve(app, provider)) as ResolvedAuditConfig<{
      memory: typeof memoryFactory
    }>

    assert.equal(resolved.default, 'memory')
    assert.equal(resolved.guarantee, 'best-effort')
    assert.deepEqual(resolved.redaction, {
      global: [],
      mode: 'mask',
      saltEnvVar: 'AUDIT_REDACTION_SALT',
    })
    assert.deepEqual(resolved.retention, { default: '730 days' })
    assert.deepEqual(resolved.chain, { enabled: true, streamBy: 'global' })
    assert.deepEqual(resolved.queue, {
      maxBatchSize: 200,
      flushIntervalMs: 250,
      capacity: 10_000,
      overflow: 'dropOldest',
    })
    assert.equal(resolved.payloadMaxBytes, 32_768)
  })

  test('stores helpers are config providers', async function ({ assert }) {
    for (const [name, factory] of Object.entries(stores)) {
      const provider = factory({})
      await assert.rejects(
        async function () {
          return configProvider.resolve(app, provider)
        },
        new RegExp(`${name}Store not implemented yet`, 'i')
      )
    }
  })

  test('ResolvedAuditConfig shape is preserved', async function ({ expectTypeOf }) {
    const provider = defineConfig({
      stores: {
        memory: memoryFactory,
      },
    })

    const resolved = (await configProvider.resolve(app, provider)) as ResolvedAuditConfig<{
      memory: typeof memoryFactory
    }>

    expectTypeOf(resolved).toEqualTypeOf<ResolvedAuditConfig<{ memory: typeof memoryFactory }>>()
    expectTypeOf(resolved.default).toEqualTypeOf<'memory'>()
  })
})
