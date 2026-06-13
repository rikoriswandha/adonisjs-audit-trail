import { BaseCommand, flags } from '@adonisjs/core/ace'

export default class AuditVerify extends BaseCommand {
  static commandName = 'audit:verify'
  static description = 'Verify audit trail hash chain integrity'

  @flags.string({ description: 'Stream to verify' })
  declare stream: string | undefined

  async run() {
    this.logger.info('audit:verify not implemented yet')
  }
}
