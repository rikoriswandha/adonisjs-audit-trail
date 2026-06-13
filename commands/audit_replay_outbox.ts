import { BaseCommand, flags } from '@adonisjs/core/ace'
import type AuditOutboxDrainer from '../src/core/outbox_drainer.js'

export default class AuditReplayOutbox extends BaseCommand {
  static commandName = 'audit:replay-outbox'
  static description = 'Replay pending transactional outbox events'

  @flags.number({ description: 'Maximum events to replay' })
  declare limit: number | undefined

  async run() {
    const drainer = (await this.app.container.make('audit.outbox_drainer')) as AuditOutboxDrainer
    const processed = await drainer.drain(this.limit ?? 1000)
    this.logger.success(`Replayed ${processed} outbox events`)
    this.exitCode = 0
  }
}
