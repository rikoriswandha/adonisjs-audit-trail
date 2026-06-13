import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { ResolvedAuditConfig } from '../src/define_config.js'

export default class AuditForget extends BaseCommand {
  static commandName = 'audit:forget'
  static description = 'Crypto-shred a data subject by deleting their encryption key'
  static options = { startApp: true as const }

  @flags.string({ description: 'Data subject identifier', required: true })
  declare subject: string

  async run() {
    const config = (await this.app.container.make('audit.config')) as ResolvedAuditConfig

    if (!config.cryptoShredding?.enabled) {
      this.logger.error('Crypto-shredding is not enabled in config/audit.ts')
      this.exitCode = 1
      return
    }

    await config.cryptoShredding.keyStore.delete(this.subject)

    this.logger.success(
      `Subject "${this.subject}" key deleted; encrypted audit values are now unreadable`
    )
    this.exitCode = 0
  }
}
