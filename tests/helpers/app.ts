import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditConfig, AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'
import type { ResolvedAuditConfig } from '../../src/define_config.js'
import { chainBatch, verifyChain } from '../../src/core/hash_chain.js'

function createMemoryStore(): AuditStoreContract {
  const events: ChainedAuditEvent[] = []

  return {
    async write(batch) {
      const byStream = new Map<string, ChainedAuditEvent[]>()
      for (const event of events) {
        const list = byStream.get(event.stream) ?? []
        list.push(event)
        byStream.set(event.stream, list)
      }

      const result: ChainedAuditEvent[] = []
      for (const event of batch) {
        const streamEvents = byStream.get(event.stream) ?? []
        const head = streamEvents[streamEvents.length - 1] ?? null
        const [chained] = chainBatch([event], head ? { seq: head.seq, hash: head.hash } : null)
        events.push(chained)
        result.push(chained)
      }
      return result
    },
    async head(stream) {
      const streamEvents = events.filter((e) => e.stream === stream)
      const last = streamEvents[streamEvents.length - 1]
      return last ? { seq: last.seq, hash: last.hash } : null
    },
    async *verify(stream, range) {
      const streamEvents = events
        .filter((e) => e.stream === stream)
        .filter((e) => range?.fromSeq === undefined || e.seq >= range.fromSeq)
        .filter((e) => range?.toSeq === undefined || e.seq <= range.toSeq)
      yield* verifyChain(
        (async function* () {
          for (const event of streamEvents) {
            yield event
          }
        })()
      )
    },
    async prune() {
      return { streams: [], totalPruned: 0, perEvent: {} }
    },
  }
}

type TestAuditConfig = {
  default: string
  guarantee: NonNullable<AuditConfig['guarantee']>
  stores: Record<string, unknown>
  redaction: Required<NonNullable<AuditConfig['redaction']>>
  retention: {
    default: string
    perEvent?: Record<string, string>
    archive?: NonNullable<NonNullable<AuditConfig['retention']>['archive']>
  }
  chain: NonNullable<AuditConfig['chain']>
  queue: Required<NonNullable<AuditConfig['queue']>>
  payloadMaxBytes: number
  captureAuthEvents: boolean
}

const defaultAuditConfig = {
  default: 'memory',
  guarantee: 'best-effort',
  stores: { memory: createMemoryStore },
  redaction: { global: [], mode: 'mask', saltEnvVar: 'AUDIT_REDACTION_SALT' },
  retention: { default: '730 days' },
  chain: { enabled: true, streamBy: 'global' },
  queue: { maxBatchSize: 200, flushIntervalMs: 5, capacity: 10_000, overflow: 'dropOldest' },
  payloadMaxBytes: 32_768,
  captureAuthEvents: true,
} satisfies TestAuditConfig

function resolveAuditConfig(auditConfig: Partial<AuditConfig>): TestAuditConfig {
  return {
    ...defaultAuditConfig,
    ...auditConfig,
    redaction: {
      ...defaultAuditConfig.redaction,
      ...auditConfig.redaction,
    },
    retention: {
      ...defaultAuditConfig.retention,
      ...auditConfig.retention,
    },
    chain: {
      ...defaultAuditConfig.chain,
      ...auditConfig.chain,
    },
    queue: {
      ...defaultAuditConfig.queue,
      ...auditConfig.queue,
    },
    stores: (auditConfig.stores ?? defaultAuditConfig.stores) as Record<string, unknown>,
    default: String(auditConfig.default ?? defaultAuditConfig.default),
  }
}

export async function createTestApp(
  auditConfig: Partial<AuditConfig> = {}
): Promise<ApplicationService> {
  const resolvedConfig = resolveAuditConfig(auditConfig)

  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .withCoreProviders()
    .preload(async (app) => {
      const stores: Record<string, AuditStoreContract> = {}

      for (const [name, factory] of Object.entries(resolvedConfig.stores)) {
        if (typeof factory === 'function') {
          stores[name] = await (
            factory as (app: ApplicationService) => Promise<AuditStoreContract>
          )(app)
        }
      }

      const configWithResolvedStores = {
        ...resolvedConfig,
        stores,
      } as unknown as ResolvedAuditConfig

      app.container.singleton('audit.config', () => configWithResolvedStores)
    })
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('../../providers/audit_provider.js'),
        ],
        commands: [() => import('../../commands/main.js')],
      },
      config: {
        database: {
          connection: 'sqlite',
          connections: {
            sqlite: {
              client: 'better-sqlite3',
              connection: { filename: ':memory:' },
            },
          },
        },
      },
    })
    .create(new URL('./tmp/', import.meta.url))

  const app = ignitor.createApp('web')
  await app.init()
  await app.boot()
  await app.start(() => {})
  return app
}

export async function cleanupTestApp(app: ApplicationService): Promise<void> {
  await app.terminate()
}
