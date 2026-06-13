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
  write(batch: AuditEvent[], chainCtx: ChainContext): Promise<ChainedAuditEvent[]>
  head(stream: string): Promise<{ seq: number; hash: string } | null>
  verify(stream: string, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<VerifyReport>
  prune(policy: ResolvedRetentionPolicy): Promise<PruneReport>
  query?(filters: AuditQueryFilters): Promise<ChainedAuditEvent[]>
}

export interface ChainContext {
  getHead(stream: string): Promise<{ seq: number; hash: string } | null>
}

// --- Config ---
export type GuaranteeMode = 'best-effort' | 'request-coupled' | 'transactional-outbox'
export type OverflowStrategy = 'dropOldest' | 'dropNew' | 'block'
export type RedactionMode = 'mask' | 'remove' | 'hash'

import type { ApplicationService, ConfigProvider } from '@adonisjs/core/types'

export type AuditStoreFactory = (application: ApplicationService) => Promise<AuditStoreContract>

export type AuditStoreResolvedConfig = Record<string, unknown>

export interface AuditConfig<
  KnownStores extends Record<string, AuditStoreFactory | ConfigProvider<AuditStoreResolvedConfig>> =
    Record<string, AuditStoreFactory | ConfigProvider<AuditStoreResolvedConfig>>,
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
  }
  queue?: {
    maxBatchSize?: number
    flushIntervalMs?: number
    capacity?: number
    overflow?: OverflowStrategy
  }
  payloadMaxBytes?: number
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

export interface RetentionPolicy {
  default: string
  perEvent?: Record<string, string>
}

export interface ResolvedRetentionPolicy extends RetentionPolicy {
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
