/*
|--------------------------------------------------------------------------
| Package entrypoint
|--------------------------------------------------------------------------
|
| Export values from the package entrypoint as you see fit.
|
*/

import { fileURLToPath } from 'node:url'

export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

export { configure } from './configure.ts'
export { defineConfig, stores } from './src/define_config.js'
export type {
  FanoutStoreOptions,
  HttpStoreOptions,
  LucidStoreOptions,
  StreamStoreOptions,
} from './src/define_config.js'
export { AuditOutboxIntegrityError, AuditTransactionRequiredError } from './src/core/errors.js'
export { fileAppendPublisher } from './src/core/anchor.js'
export { LucidSubjectKeyStore, MemorySubjectKeyStore } from './src/core/subject_crypto.js'

export type {
  AuditEvent,
  ChainedAuditEvent,
  AuditActor,
  AuditActorReference,
  ActorType,
  AuditStoreContract,
  GuaranteeMode,
  OverflowStrategy,
  RedactionMode,
  AuditConfig,
  AuditQueryFilters,
  VerifyReport,
  PruneReport,
  PipelineStats,
  AuditFlushedEvent,
  AuditDroppedEvent,
  AuditDeadLetterEvent,
  AuditRuntimeEvents,
  KnownAuditEvent,
  AuditableModelConfig,
  RetentionPolicy,
  ResolvedRetentionPolicy,
  AuditEvents,
  ChainHead,
  AnchorConfig,
  SubjectKeyStore,
  CryptoShreddingConfig,
} from './src/types.js'
export type {
  AuditOutboxConfig,
  AuditReadOptions,
  AuditSubmissionOptions,
  AuditSubmissionSource,
  AuditableModelInstance,
  AuditStoreFactory,
  AuditStoreResolvedConfig,
  AuditErrorEvent,
  RetentionSegment,
} from './src/types.js'
export type { AuditQuery } from './src/models/audit.js'
