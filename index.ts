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
  AuditEvent,
  ChainedAuditEvent,
  AuditActor,
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
