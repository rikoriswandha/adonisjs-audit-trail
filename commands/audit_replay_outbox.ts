import { BaseCommand, flags } from '@adonisjs/core/ace'

export default class AuditReplayOutbox extends BaseCommand {
  static commandName = 'audit:replay-outbox'
  static description = 'Replay pending transactional outbox events'

  @flags.number({ description: 'Maximum events to replay' })
  declare limit: number | undefined

  async run() {
    this.logger.info('audit:replay-outbox not implemented yet')
  }
}
