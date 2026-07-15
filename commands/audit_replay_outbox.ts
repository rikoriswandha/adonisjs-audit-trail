import { BaseCommand, flags } from '@adonisjs/core/ace'
import type AuditOutboxDrainer from '../src/core/outbox_drainer.js'

export default class AuditReplayOutbox extends BaseCommand {
  static commandName = 'audit:replay-outbox'
  static description = 'Replay pending transactional outbox events'
  static options = { startApp: true as const }

  @flags.number({ description: 'Maximum events to requeue and replay' })
  declare limit: number | undefined

  @flags.boolean({ description: 'Return failed rows to pending before replaying' })
  declare requeue: boolean | undefined

  async run() {
    const drainer = (await this.app.container.make('audit.outbox_drainer')) as AuditOutboxDrainer
    const limit = this.limit ?? 1000
    const requeued = this.requeue ? await drainer.requeue(limit) : 0
    const processed = await drainer.drain(limit)
    this.logger.success(
      this.requeue
        ? `Requeued ${requeued} and replayed ${processed} outbox events`
        : `Replayed ${processed} outbox events`
    )
    this.exitCode = 0
  }
}
