import { BaseCommand, flags } from '@adonisjs/core/ace'

export default class AuditPrune extends BaseCommand {
  static commandName = 'audit:prune'
  static description = 'Prune audit events according to retention policy'

  @flags.string({ description: 'Event name to prune' })
  declare event: string | undefined

  @flags.boolean({ description: 'Run without deleting (dry run)' })
  declare dryRun: boolean | undefined

  async run() {
    this.logger.info('audit:prune not implemented yet')
  }
}
