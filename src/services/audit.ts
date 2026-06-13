import type { AuditEvent, AuditActor, PipelineStats } from '../types.js'
import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'

export default class AuditService {
  constructor(
    protected manager: StoreManager,
    protected pipeline: AuditPipeline
  ) {}

  log(_event: string): {
    on: Function
    by: Function
    withMeta: Function
    tag: Function
    commit: Function
    commitSync: Function
  } {
    throw new Error('AuditService.log: not implemented')
  }

  withinContext<T>(_store: Record<string, unknown>, _fn: () => T): T {
    throw new Error('AuditService.withinContext: not implemented')
  }

  actor(_actor: AuditActor): this {
    throw new Error('AuditService.actor: not implemented')
  }

  emit(_event: AuditEvent): Promise<void> {
    throw new Error('AuditService.emit: not implemented')
  }

  stats(): PipelineStats {
    return { queued: 0, written: 0, dropped: 0, retried: 0, deadLettered: 0, lastFlushAt: null }
  }
}
