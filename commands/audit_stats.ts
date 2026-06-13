import { BaseCommand, flags } from '@adonisjs/core/ace'

export default class AuditStats extends BaseCommand {
  static commandName = 'audit:stats'
  static description = 'Show audit pipeline and store statistics'

  @flags.string({ description: 'Store name' })
  declare store: string | undefined

  async run() {
    this.logger.info('audit:stats not implemented yet')
  }
}
