import { configProvider } from '@adonisjs/core'
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import type { HttpContext } from '@adonisjs/core/http'
import type { Writable } from 'node:stream'
import { AuditConfigurationError, AuditPeerDependencyError } from './core/errors.js'
import type {
  AnchorConfig,
  AuditConfig,
  AuditEvent,
  AuditStoreContract,
  AuditStoreFactory,
  CryptoShreddingConfig,
  GuaranteeMode,
  OverflowStrategy,
  RedactionMode,
  ResolvedRetentionPolicy,
} from './types.js'

export type ResolvedAuditConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreContract>> =
    Record<string, AuditStoreFactory | ConfigProvider<AuditStoreContract>>,
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
    anchor?: AnchorConfig
  }
  cryptoShredding?: CryptoShreddingConfig
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

const FANOUT_CONFIG = Symbol('fanoutConfig')

interface FanoutConfigProvider extends ConfigProvider<AuditStoreContract> {
  [FANOUT_CONFIG]: true
  options: FanoutStoreOptions
}

function isFanoutProvider(
  value: AuditStoreFactory | ConfigProvider<AuditStoreContract>
): value is FanoutConfigProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    FANOUT_CONFIG in value &&
    (value as FanoutConfigProvider)[FANOUT_CONFIG] === true
  )
}

export function defineConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreContract>>,
>(config: AuditConfig<KnownStores>): ConfigProvider<ResolvedAuditConfig<KnownStores>> {
  return configProvider.create(async (app) => {
    const resolvedStores = {} as Record<string, AuditStoreContract>
    const fanoutEntries: { name: string; provider: FanoutConfigProvider }[] = []

    for (const [name, storeConfig] of Object.entries(config.stores)) {
      if (isFanoutProvider(storeConfig)) {
        fanoutEntries.push({ name, provider: storeConfig })
        continue
      }

      resolvedStores[name] = await resolveStoreConfig(app, storeConfig)
    }

    for (const { name, provider } of fanoutEntries) {
      const store = (await configProvider.resolve(app, provider)) as AuditStoreContract
      bindFanoutStore(store, resolvedStores)
      resolvedStores[name] = store
    }

    const defaultStore = (config.default ?? 'lucid') as keyof KnownStores
    if (!Object.hasOwn(config.stores, defaultStore)) {
      throw new AuditConfigurationError(
        `Default audit store "${String(defaultStore)}" is not configured`
      )
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
        ...(config.chain?.anchor !== undefined ? { anchor: config.chain.anchor } : {}),
      },
      ...(config.cryptoShredding !== undefined ? { cryptoShredding: config.cryptoShredding } : {}),
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

async function resolveStoreConfig(
  app: ApplicationService,
  storeConfig: AuditStoreFactory | ConfigProvider<AuditStoreContract>
): Promise<AuditStoreContract> {
  if (typeof storeConfig === 'function') {
    return (storeConfig as AuditStoreFactory)(app)
  }

  const resolved = await configProvider.resolve(app, storeConfig)
  if (resolved === null) {
    throw new AuditConfigurationError('Invalid config provider for audit store')
  }

  return resolved as AuditStoreContract
}

function bindFanoutStore(
  store: AuditStoreContract,
  stores: Record<string, AuditStoreContract>
): void {
  const fanout = store as { bindStores?: (stores: Record<string, AuditStoreContract>) => void }
  if (typeof fanout.bindStores === 'function') {
    fanout.bindStores(stores)
  }
}

export interface LucidStoreOptions {
  connection?: string
  table?: string
  enforceImmutability?: boolean
}

export interface StreamStoreOptions {
  destination?: 'stdout' | 'stderr' | string | Writable
  format?: 'ndjson' | 'json'
}

export interface HttpStoreOptions {
  url: string
  headers?: Record<string, string>
  signature?: {
    secretEnvVar: string
    header?: string
    algorithm?: 'sha256'
  }
  idempotencyHeader?: string
}

export interface FanoutStoreOptions {
  primary: string | AuditStoreContract
  mirrors?: (string | AuditStoreContract)[]
  mirrorFailure?: 'log' | 'throw'
}

export const stores = {
  lucid: (opts: LucidStoreOptions = {}) =>
    configProvider.create(async (app: ApplicationService) => {
      const { default: LucidStore } = await import('./stores/lucid_store.js').catch(() => {
        throw new AuditPeerDependencyError(
          '@adonisjs/lucid is required for the lucid store. Install it as a peer dependency.'
        )
      })
      return new LucidStore(app, opts)
    }),
  stream: (opts: StreamStoreOptions = {}) =>
    configProvider.create(async () => {
      const { default: StreamStore } = await import('./stores/stream_store.js')
      return new StreamStore(opts)
    }),
  http: (opts: HttpStoreOptions) =>
    configProvider.create(async () => {
      const { default: HttpStore } = await import('./stores/http_store.js')
      return new HttpStore(opts)
    }),
  fanout: (opts: FanoutStoreOptions) => {
    const base = configProvider.create(async () => {
      const { default: FanoutStore } = await import('./stores/fanout_store.js')
      return new FanoutStore(opts)
    })

    return Object.assign(base, { [FANOUT_CONFIG]: true as const, options: opts })
  },
}
