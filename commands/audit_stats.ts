import { BaseCommand, flags } from '@adonisjs/core/ace'
import type AuditPipeline from '../src/core/pipeline.js'
import type AuditOutboxDrainer from '../src/core/outbox_drainer.js'

export default class AuditStats extends BaseCommand {
  static commandName = 'audit:stats'
  static description = 'Show audit pipeline and store statistics'
  static options = { startApp: true as const }

  @flags.string({ description: 'Store name' })
  declare store: string | undefined

  @flags.string({ description: 'Stream name' })
  declare stream: string | undefined

  async run() {
    const manager = await this.app.container.make('audit.manager')
    const pipeline = (await this.app.container.make('audit.pipeline')) as AuditPipeline

    const stats = pipeline.stats()
    const drainer = (await this.app.container.make('audit.outbox_drainer')) as AuditOutboxDrainer
    const outbox = await drainer.stats()

    const store = manager.use(this.store)
    const stream = this.stream ?? 'default'
    const head = await store.head(stream)

    this.logger.log('Pipeline stats')
    this.logger.log(`  queued:        ${stats.queued}`)
    this.logger.log(`  written:       ${stats.written}`)
    this.logger.log(`  dropped:       ${stats.dropped}`)
    this.logger.log(`  retried:       ${stats.retried}`)
    this.logger.log(`  dead-lettered: ${stats.deadLettered}`)
    this.logger.log(`  last flush:    ${stats.lastFlushAt?.toISOString() ?? 'never'}`)

    this.logger.log('Outbox stats')
    this.logger.log(`  pending:       ${outbox.pending}`)
    this.logger.log(`  failed:        ${outbox.failed}`)
    this.logger.log(`  attempts:      ${outbox.attempts}`)
    this.logger.log(
      `  oldest pending: ${
        outbox.oldestPendingAgeMs === null ? 'none' : `${outbox.oldestPendingAgeMs}ms`
      }`
    )

    this.logger.log(`Store: ${this.store ?? manager.default}`)
    if (head) {
      this.logger.log(`  stream "${stream}" head seq=${head.seq} hash=${head.hash}`)
    } else {
      this.logger.log(`  stream "${stream}" is empty`)
    }
    this.exitCode = 0
  }
}
