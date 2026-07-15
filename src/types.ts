import type { HttpContext } from '@adonisjs/core/http'
import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type Audit from './models/audit.js'
import type { AuditQuery } from './models/audit.js'

// --- Actor ---
export type ActorType = 'user' | 'system' | 'job' | 'cli' | (string & {})

export interface AuditActor {
  type: ActorType
  id: string | null
  label?: string | null
}

export interface AuditActorReference {
  id: string | number | null
  type?: ActorType
  constructor?: {
    name?: string
    auditActorType?: ActorType
  }
}

// --- Events ---
export interface AuditEvent {
  id: string // UUIDv7
  event: string
  stream: string
  auditableType: string | null
  auditableId: string | null
  oldValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  actor: AuditActor
  tenantId: string | null
  requestId: string | null
  correlationId: string | null
  ipAddress: string | null
  userAgent: string | null
  url: string | null
  httpMethod: string | null
  tags: string[]
  schemaVersion: '1'
  createdAt: string // ISO-8601 UTC ms
}
export interface ChainedAuditEvent extends AuditEvent {
  seq: number
  hash: string
  prevHash: string
}

// --- Store contract ---
export interface AuditStoreContract {
  write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]>
  head(stream: string, options?: AuditReadOptions): Promise<{ seq: number; hash: string } | null>
  verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number },
    options?: AuditReadOptions
  ): AsyncIterable<VerifyReport>
  prune(policy: ResolvedRetentionPolicy): Promise<PruneReport>
  query?(filters: AuditQueryFilters, options?: AuditReadOptions): Promise<ChainedAuditEvent[]>
  listStreams?(options?: AuditReadOptions): Promise<string[]>
  resolveSequenceHash?(
    stream: string,
    seq: number,
    options?: AuditReadOptions
  ): Promise<string | null>
  /**
   * Optional support for selecting a named connection for an operation.
   * Returns a store instance bound to the given connection.
   */
  withConnection?(connection: string): AuditStoreContract
}

// --- Config ---
export type GuaranteeMode = 'best-effort' | 'request-coupled' | 'transactional-outbox'
export type OverflowStrategy = 'dropOldest' | 'dropNew' | 'block'
export type RedactionMode = 'mask' | 'remove' | 'hash'

export type AuditStoreFactory = (application: ApplicationService) => Promise<AuditStoreContract>

export type AuditStoreResolvedConfig = Record<string, unknown>

export interface AuditConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreContract>> =
    Record<string, AuditStoreFactory | ConfigProvider<AuditStoreContract>>,
> {
  default?: keyof KnownStores
  guarantee?: GuaranteeMode
  stores: KnownStores
  redaction?: {
    global?: string[]
    mode?: RedactionMode
    saltEnvVar?: string
  }
  retention?: {
    default?: string
    perEvent?: Record<string, string>
    archive?: (segment: RetentionSegment) => Promise<void>
  }
  chain?: {
    streamBy?: 'global' | 'tenant' | ((event: AuditEvent) => string)
    anchor?: AnchorConfig
  }
  cryptoShredding?: CryptoShreddingConfig
  queue?: {
    maxBatchSize?: number
    flushIntervalMs?: number
    capacity?: number
    overflow?: OverflowStrategy
  }
  outbox?: AuditOutboxConfig
  payloadMaxBytes?: number

  tenantResolver?: (ctx: HttpContext) => string | null | Promise<string | null>
  captureAuthEvents?: boolean
}

export interface AuditOutboxConfig {
  connection?: string
  table?: string
  executor?: <T>(
    tenantId: string | null,
    operation: (transaction: TransactionClientContract) => Promise<T>
  ) => Promise<T>
  maxAttempts?: number
  retryDelayMs?: number
  staleClaimMs?: number
}

export interface AuditReadOptions {
  connection?: string
  client?: QueryClientContract
}

export type AuditSubmissionSource = 'domain' | 'model' | 'auth'

export interface AuditSubmissionOptions {
  transaction?: TransactionClientContract
  source?: AuditSubmissionSource
}

// --- Module augmentation point ---
export interface AuditEvents {}
export type KnownAuditEvent = keyof AuditEvents extends never ? string : keyof AuditEvents

// --- Query & reporting ---
export interface AuditQueryFilters {
  stream?: string
  event?: string | string[]
  auditableType?: string
  auditableId?: string
  actorType?: string
  actorId?: string
  tenantId?: string
  fromSeq?: number
  toSeq?: number
  fromCreatedAt?: string
  toCreatedAt?: string
  limit?: number
  /** Exclusive sequence cursor. Results have `seq > cursor`, never an offset. */
  cursor?: number
}

export interface VerifyReport {
  stream: string
  valid: boolean
  firstInvalidSeq?: number
  expectedHash?: string
  actualHash?: string
  checkedCount: number
}

export interface ChainHead {
  stream: string
  seq: number
  hash: string
  anchoredAt: string
}

export interface AnchorConfig {
  every: number | 'daily'
  publish: (head: ChainHead) => Promise<void>
  anchorsFile?: string
}

export interface SubjectKeyStore {
  get(subjectId: string, client?: TransactionClientContract): Promise<string | null>
  set(subjectId: string, key: string, client?: TransactionClientContract): Promise<void>
  delete(subjectId: string, client?: TransactionClientContract): Promise<void>
}

export interface CryptoShreddingConfig {
  enabled: boolean
  fields: string[]
  keyStore: SubjectKeyStore
  subjectResolver?: (event: AuditEvent) => string | null | Promise<string | null>
}

export interface PruneReport {
  streams: string[]
  totalPruned: number
  perEvent: Record<string, number>
}

export interface PipelineStats {
  queued: number
  written: number
  dropped: number
  retried: number
  deadLettered: number
  lastFlushAt: Date | null
}
export interface AuditFlushedEvent {
  store: string
  events: ChainedAuditEvent[]
  count: number
}

export interface AuditDroppedEvent {
  strategy: OverflowStrategy
  count: number
  event: AuditEvent
}

export interface AuditDeadLetterEvent {
  events: AuditEvent[]
  count: number
  error: unknown
}

export interface AuditErrorEvent {
  event: AuditEvent | null
  error: unknown
  source: AuditSubmissionSource
}

export interface AuditRuntimeEvents {
  'audit:flushed': AuditFlushedEvent
  'audit:dropped': AuditDroppedEvent
  'audit:dead_letter': AuditDeadLetterEvent
  'audit:error': AuditErrorEvent
}

declare module '@adonisjs/core/types' {
  export interface EventsList extends AuditRuntimeEvents {}
}

export interface RetentionPolicy {
  default: string
  perEvent?: Record<string, string>
}

export interface ResolvedRetentionPolicy extends RetentionPolicy {
  dryRun?: boolean
  archive?: (segment: RetentionSegment) => Promise<void>
  eventFilter?: string
}

export interface RetentionSegment {
  /** Stable archive idempotency key derived from the stream and sequence range. */
  idempotencyKey: string
  event: string
  stream: string
  fromSeq: number
  toSeq: number
  count: number
  fromCreatedAt: string
  toCreatedAt: string
}

// --- Auditable mixin config ---
export interface AuditableModelConfig {
  events?: ('created' | 'updated' | 'deleted' | 'restored')[]
  exclude?: string[]
  redact?: string[]
  tags?: string[]
  snapshot?: 'diff' | 'full'
  strict?: boolean
}

export interface AuditableModelInstance {
  audits(): AuditQuery
  lastAudit(): Promise<Audit | null>
}

// Container bindings augmentation
import './types/container_bindings.js'
export type { ApplicationService }
