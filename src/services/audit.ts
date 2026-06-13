import type { AuditEvent, KnownAuditEvent, PipelineStats } from '../types.js'
import type { AuditContextStore, auditContext as AuditContext } from '../audit_context.js'
import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'
import type { AssembleConfig, AssembleInput } from '../core/assembler.js'
import { assembleEvent } from '../core/assembler.js'
import LogBuilder from './log_builder.js'

export interface AuditServiceConfig {
  assemble: AssembleConfig
  context: typeof AuditContext
}

export default class AuditService {
  constructor(
    protected manager: StoreManager,
    protected pipeline: AuditPipeline,
    protected config: AuditServiceConfig
  ) {}

  log(event: KnownAuditEvent): LogBuilder {
    return new LogBuilder(this, String(event))
  }

  withinContext<T>(store: Partial<AuditContextStore>, fn: () => T): T {
    return this.config.context.run(store, fn)
  }

  stats(): PipelineStats {
    return this.pipeline.stats()
  }

  emit(event: AuditEvent): boolean {
    return this.pipeline.enqueue(event)
  }

  async emitLog(builder: LogBuilder): Promise<void> {
    const context = this.config.context.get() ?? {}
    const input: AssembleInput = {
      event: builder.event,
      auditableType: builder.auditableType,
      auditableId: builder.auditableId,
      oldValues: builder.oldValues,
      newValues: builder.newValues,
      metadata: builder.metadata,
      tags: builder.tags,
      actor: builder.actor,
    }

    const event = await assembleEvent(input, context, this.config.assemble)
    this.pipeline.enqueue(event)
  }

  async emitLogSync(builder: LogBuilder, timeoutMs?: number): Promise<void> {
    const context = this.config.context.get() ?? {}
    const input: AssembleInput = {
      event: builder.event,
      auditableType: builder.auditableType,
      auditableId: builder.auditableId,
      oldValues: builder.oldValues,
      newValues: builder.newValues,
      metadata: builder.metadata,
      tags: builder.tags,
      actor: builder.actor,
    }

    const event = await assembleEvent(input, context, this.config.assemble)
    this.pipeline.enqueue(event)
    await this.pipeline.requestCoupledFlush([event.id], timeoutMs)
  }
}
