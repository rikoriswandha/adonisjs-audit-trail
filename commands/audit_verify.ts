import { BaseCommand, flags } from '@adonisjs/core/ace'
import Audit from '../src/models/audit.js'
import type StoreManager from '../src/stores/store_manager.js'
import type { VerifyReport } from '../src/types.js'

export default class AuditVerify extends BaseCommand {
  static commandName = 'audit:verify'
  static description = 'Verify audit trail hash chain integrity'

  @flags.string({ description: 'Stream to verify' })
  declare stream: string | undefined

  @flags.number({ description: 'Start sequence (inclusive)' })
  declare fromSeq: number | undefined

  @flags.number({ description: 'End sequence (inclusive)' })
  declare toSeq: number | undefined

  @flags.boolean({ description: 'Output JSON' })
  declare json: boolean | undefined

  async run() {
    const manager = await this.app.container.make('audit.manager')
    const store = manager.use()

    const streams = await this.#resolveStreams(store, manager.default)
    if (streams.length === 0) {
      this.logger.warning('No audit streams found to verify')
      return
    }

    let failed = false
    const reports: VerifyReport[] = []

    for (const stream of streams) {
      for await (const report of store.verify(stream, {
        fromSeq: this.fromSeq,
        toSeq: this.toSeq,
      })) {
        if (this.json) {
          reports.push(report)
        } else {
          this.#printReport(report)
        }

        if (!report.valid) {
          failed = true
          if (!this.json) {
            this.logger.error(
              `Chain break detected in stream "${stream}" at seq ${report.firstInvalidSeq}`
            )
            this.exitCode = 1
            return
          }
        }
      }
    }

    if (this.json) {
      this.logger.log(JSON.stringify(reports, null, 2))
    }

    if (failed) {
      this.exitCode = 1
      this.logger.error('Audit chain verification failed')
    } else {
      this.exitCode = 0
      this.logger.success('Audit chain verification passed')
    }
  }

  async #resolveStreams(
    store: ReturnType<StoreManager['use']>,
    storeName: string
  ): Promise<string[]> {
    if (this.stream) {
      return [this.stream]
    }

    if (storeName !== 'lucid' && !('query' in store)) {
      this.logger.warning(
        'Stream auto-detection is only supported for the lucid store. Use --stream.'
      )
      return []
    }

    const rows = await Audit.query().distinct('stream')
    return rows.map((row) => row.stream)
  }

  #printReport(report: VerifyReport) {
    if (report.valid) {
      this.logger.log(`✓ stream="${report.stream}" checked=${report.checkedCount}`)
      return
    }

    this.logger.log(
      `✗ stream="${report.stream}" firstInvalidSeq=${report.firstInvalidSeq} expected=${report.expectedHash} actual=${report.actualHash} checked=${report.checkedCount}`
    )
  }
}
