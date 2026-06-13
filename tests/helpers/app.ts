import { IgnitorFactory } from '@adonisjs/core/factories'
import type { ApplicationService } from '@adonisjs/core/types'
import type { ResolvedAuditConfig } from '../../src/define_config.js'

const auditConfig = {
  default: 'memory',
  guarantee: 'best-effort',
  stores: { memory: {} },
  redaction: { global: [], mode: 'mask', saltEnvVar: 'AUDIT_REDACTION_SALT' },
  retention: { default: '730 days' },
  chain: { enabled: true, streamBy: 'global' },
  queue: { maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' },
  payloadMaxBytes: 32_768,
} as unknown as ResolvedAuditConfig

export async function createTestApp(): Promise<ApplicationService> {
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .withCoreProviders()
    .preload((app) => {
      app.container.singleton('audit.config', () => auditConfig)
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
