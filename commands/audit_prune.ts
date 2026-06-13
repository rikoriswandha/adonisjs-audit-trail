import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { ResolvedAuditConfig } from '../src/define_config.js'
import type { ResolvedRetentionPolicy } from '../src/types.js'
export default class AuditPrune extends BaseCommand {
  static commandName = 'audit:prune'
  static description = 'Prune audit events according to retention policy'
  static options = { startApp: true as const }

  @flags.string({ description: 'Event name to prune' })
  declare event: string | undefined

  @flags.boolean({ description: 'Run without deleting (dry run)' })
  declare dryRun: boolean | undefined

  @flags.string({ description: 'Store connection name (for stores that support it)' })
  declare connection: string | undefined

  async run() {
    const config = (await this.app.container.make('audit.config')) as ResolvedAuditConfig
    const manager = await this.app.container.make('audit.manager')
    const store = manager.use(undefined, this.connection)

    const policy: ResolvedRetentionPolicy = {
      default: config.retention.default,
      ...(config.retention.perEvent !== undefined ? { perEvent: config.retention.perEvent } : {}),
      ...(this.event !== undefined ? { eventFilter: this.event } : {}),
      dryRun: this.dryRun === true,
      ...(config.retention.archive !== undefined && this.dryRun !== true
        ? { archive: config.retention.archive }
        : {}),
    }

    const report = await store.prune(policy)

    if (this.dryRun) {
      this.logger.info(`Dry run: ${report.totalPruned} events would be pruned`)
    } else {
      this.logger.success(`Pruned ${report.totalPruned} events`)
    }

    this.logger.log(`Streams affected: ${report.streams.join(', ') || 'none'}`)
    for (const [event, count] of Object.entries(report.perEvent)) {
      this.logger.log(`  ${event}: ${count}`)
    }
    this.exitCode = 0
  }
}
