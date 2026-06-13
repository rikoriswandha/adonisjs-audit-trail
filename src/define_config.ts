import { configProvider } from '@adonisjs/core'
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import type {
  AuditConfig,
  AuditEvent,
  AuditStoreFactory,
  AuditStoreResolvedConfig,
  GuaranteeMode,
  OverflowStrategy,
  RedactionMode,
  ResolvedRetentionPolicy,
} from './types.js'

export type ResolvedAuditConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreResolvedConfig>> =
    Record<string, AuditStoreFactory | ConfigProvider<AuditStoreResolvedConfig>>,
> = {
  default: keyof KnownStores
  guarantee: GuaranteeMode
  stores: {
    [K in keyof KnownStores]: KnownStores[K] extends ConfigProvider<infer A>
      ? A
      : KnownStores[K] extends (application: ApplicationService) => Promise<infer R>
        ? R
        : KnownStores[K]
  }
  redaction: {
    global: string[]
    mode: RedactionMode
    saltEnvVar: string
  }
  retention: ResolvedRetentionPolicy
  chain: {
    enabled: boolean
    streamBy: 'global' | 'tenant' | ((event: AuditEvent) => string)
  }
  queue: {
    maxBatchSize: number
    flushIntervalMs: number
    capacity: number
    overflow: OverflowStrategy
  }
  payloadMaxBytes: number
}

export function defineConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreResolvedConfig>>,
>(config: AuditConfig<KnownStores>): ConfigProvider<ResolvedAuditConfig<KnownStores>> {
  return configProvider.create(async (app) => {
    const resolvedStores = {} as Record<string, unknown>

    for (const [name, storeConfig] of Object.entries(config.stores)) {
      if (typeof storeConfig === 'function') {
        resolvedStores[name] = await (storeConfig as AuditStoreFactory)(app)
      } else {
        const resolved = await configProvider.resolve(app, storeConfig)
        if (resolved === null) {
          throw new Error(`Invalid config provider for store "${name}"`)
        }
        resolvedStores[name] = resolved
      }
    }

    return {
      default: (config.default ?? Object.keys(config.stores)[0]) as keyof KnownStores,
      guarantee: config.guarantee ?? 'best-effort',
      stores: resolvedStores as ResolvedAuditConfig<KnownStores>['stores'],
      redaction: {
        global: config.redaction?.global ?? [],
        mode: config.redaction?.mode ?? 'mask',
        saltEnvVar: config.redaction?.saltEnvVar ?? 'AUDIT_REDACTION_SALT',
      },
      retention: {
        default: config.retention?.default ?? '730 days',
        ...(config.retention?.perEvent !== undefined
          ? { perEvent: config.retention.perEvent }
          : {}),
        ...(config.retention?.archive !== undefined ? { archive: config.retention.archive } : {}),
      },
      chain: {
        enabled: config.chain?.enabled ?? true,
        streamBy: config.chain?.streamBy ?? 'global',
      },
      queue: {
        maxBatchSize: config.queue?.maxBatchSize ?? 200,
        flushIntervalMs: config.queue?.flushIntervalMs ?? 250,
        capacity: config.queue?.capacity ?? 10_000,
        overflow: config.queue?.overflow ?? 'dropOldest',
      },
      payloadMaxBytes: config.payloadMaxBytes ?? 32_768,
    }
  })
}

export const stores = {
  lucid: (_opts: Record<string, unknown>) =>
    configProvider.create(async () => {
      throw new Error('LucidStore not implemented yet')
    }),
  stream: (_opts: Record<string, unknown>) =>
    configProvider.create(async () => {
      throw new Error('StreamStore not implemented yet')
    }),
  http: (_opts: Record<string, unknown>) =>
    configProvider.create(async () => {
      throw new Error('HttpStore not implemented yet')
    }),
  fanout: (_opts: Record<string, unknown>) =>
    configProvider.create(async () => {
      throw new Error('FanoutStore not implemented yet')
    }),
}
