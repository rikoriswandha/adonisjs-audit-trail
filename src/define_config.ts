import { configProvider } from '@adonisjs/core'
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import type { HttpContext } from '@adonisjs/core/http'
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
  tenantResolver?: (ctx: HttpContext) => string | null | Promise<string | null>
  captureAuthEvents: boolean
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

    const defaultStore = (config.default ?? 'lucid') as keyof KnownStores
    if (!Object.hasOwn(config.stores, defaultStore)) {
      throw new Error(`Default audit store "${String(defaultStore)}" is not configured`)
    }

    return {
      default: defaultStore,
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
      tenantResolver: config.tenantResolver,
      captureAuthEvents: config.captureAuthEvents ?? true,
    }
  })
}
export interface LucidStoreOptions {
  connection?: string
  table?: string
  enforceImmutability?: boolean
}

export type StreamStoreOptions = Record<string, never>
export type HttpStoreOptions = Record<string, never>
export type FanoutStoreOptions = Record<string, never>

export const stores = {
  lucid: (opts: LucidStoreOptions = {}) =>
    configProvider.create(async (app: ApplicationService) => {
      const { default: LucidStore } = await import('./stores/lucid_store.js').catch(() => {
        throw new Error(
          '@adonisjs/lucid is required for the lucid store. Install it as a peer dependency.'
        )
      })
      return new LucidStore(app, opts)
    }),
  stream: (_opts: StreamStoreOptions = {}) =>
    configProvider.create(async () => {
      const { default: StreamStore } = await import('./stores/stream_store.js')
      return new StreamStore()
    }),
  http: (_opts: HttpStoreOptions = {}) =>
    configProvider.create(async () => {
      const { default: HttpStore } = await import('./stores/http_store.js')
      return new HttpStore()
    }),
  fanout: (_opts: FanoutStoreOptions = {}) =>
    configProvider.create(async () => {
      const { default: FanoutStore } = await import('./stores/fanout_store.js')
      return new FanoutStore()
    }),
}
