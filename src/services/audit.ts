import type { AuditEvent, GuaranteeMode, KnownAuditEvent, PipelineStats } from '../types.js'
import type { AuditContextStore, auditContext as AuditContext } from '../audit_context.js'
import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'
import type { AssembleConfig, AssembleInput } from '../core/assembler.js'
import { assembleEvent } from '../core/assembler.js'
import { AuditDroppedError } from '../core/errors.js'
import LogBuilder from './log_builder.js'
export interface AuditServiceConfig {
  assemble: AssembleConfig
  context: typeof AuditContext
  guarantee: GuaranteeMode
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
    const event = await this.#assembleBuilderEvent(builder)
    const enqueued = this.pipeline.enqueue(event)

    if (!enqueued && this.config.guarantee !== 'best-effort') {
      throw new AuditDroppedError()
    }

    if (enqueued && this.config.guarantee === 'request-coupled') {
      await this.pipeline.requestCoupledFlush([event.id])
    }
  }

  async emitLogSync(builder: LogBuilder, timeoutMs?: number): Promise<void> {
    const event = await this.#assembleBuilderEvent(builder)
    const enqueued = this.pipeline.enqueue(event)

    if (!enqueued) {
      throw new AuditDroppedError()
    }

    await this.pipeline.requestCoupledFlush([event.id], timeoutMs)
  }
  async #assembleBuilderEvent(builder: LogBuilder): Promise<AuditEvent> {
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

    return assembleEvent(input, context, this.config.assemble)
  }
}
