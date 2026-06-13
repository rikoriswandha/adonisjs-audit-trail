// --- Actor ---
export type ActorType = 'user' | 'system' | 'job' | 'cli' | (string & {})

export interface AuditActor {
  type: ActorType
  id: string | null
  label?: string | null
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
  head(stream: string): Promise<{ seq: number; hash: string } | null>
  verify(stream: string, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<VerifyReport>
  prune(policy: ResolvedRetentionPolicy): Promise<PruneReport>
  query?(filters: AuditQueryFilters): Promise<ChainedAuditEvent[]>
}

// --- Config ---
export type GuaranteeMode = 'best-effort' | 'request-coupled' | 'transactional-outbox'
export type OverflowStrategy = 'dropOldest' | 'dropNew' | 'block'
export type RedactionMode = 'mask' | 'remove' | 'hash'

import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'
import type { HttpContext } from '@adonisjs/core/http'

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
    enabled?: boolean
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
  payloadMaxBytes?: number

  tenantResolver?: (ctx: HttpContext) => string | null | Promise<string | null>
  captureAuthEvents?: boolean
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
  cursor?: number // seq-based cursor
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
  get(subjectId: string): Promise<string | null>
  set(subjectId: string, key: string): Promise<void>
  delete(subjectId: string): Promise<void>
}

export interface CryptoShreddingConfig {
  enabled: boolean
  fields: string[]
  keyStore: SubjectKeyStore
  subjectResolver?: (event: AuditEvent) => string | null
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
  source: 'model' | 'domain' | 'auth'
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
}

export interface RetentionSegment {
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

// Container bindings augmentation
import './types/container_bindings.js'
export type { ApplicationService }
