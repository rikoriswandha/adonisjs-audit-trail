import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditConfig } from '../../src/types.js'
import type { ResolvedAuditConfig } from '../../src/define_config.js'

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
  chain: Required<NonNullable<AuditConfig['chain']>>
  queue: Required<NonNullable<AuditConfig['queue']>>
  payloadMaxBytes: number
}

const defaultAuditConfig = {
  default: 'memory',
  guarantee: 'best-effort',
  stores: { memory: {} },
  redaction: { global: [], mode: 'mask', saltEnvVar: 'AUDIT_REDACTION_SALT' },
  retention: { default: '730 days' },
  chain: { enabled: true, streamBy: 'global' },
  queue: { maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' },
  payloadMaxBytes: 32_768,
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
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .withCoreProviders()
    .preload((app) => {
      app.container.singleton(
        'audit.config',
        () => resolveAuditConfig(auditConfig) as unknown as ResolvedAuditConfig
      )
    })
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('../../providers/audit_provider.js'),
        ],
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
