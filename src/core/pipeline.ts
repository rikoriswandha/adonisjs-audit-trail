import type { AuditEvent, PipelineStats } from '../types.js'

export default class AuditPipeline {
  enqueue(_event: AuditEvent): boolean {
    throw new Error('AuditPipeline.enqueue: not implemented')
  }

  start(): void {
    // M2: start flusher
  }

  async shutdown(_deadlineMs?: number): Promise<void> {
    // M2: drain
  }

  stats(): PipelineStats {
    return { queued: 0, written: 0, dropped: 0, retried: 0, deadLettered: 0, lastFlushAt: null }
  }
}
