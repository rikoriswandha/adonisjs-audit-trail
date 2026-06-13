import { BaseCommand, flags } from '@adonisjs/core/ace'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import Audit from '../src/models/audit.js'
import type StoreManager from '../src/stores/store_manager.js'
import type { ChainHead, VerifyReport } from '../src/types.js'
import type { ResolvedAuditConfig } from '../src/define_config.js'

export default class AuditVerify extends BaseCommand {
  static commandName = 'audit:verify'
  static description = 'Verify audit trail hash chain integrity'
  static options = { startApp: true as const }

  @flags.string({ description: 'Stream to verify' })
  declare stream: string | undefined

  @flags.number({ description: 'Start sequence (inclusive)' })
  declare fromSeq: number | undefined

  @flags.number({ description: 'End sequence (inclusive)' })
  declare toSeq: number | undefined

  @flags.boolean({ description: 'Output JSON' })
  declare json: boolean | undefined

  @flags.boolean({ description: 'Check anchored chain heads against anchor file' })
  declare checkAnchors: boolean | undefined

  async run() {
    const manager = await this.app.container.make('audit.manager')
    const config = (await this.app.container.make('audit.config')) as ResolvedAuditConfig
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

      if (this.checkAnchors) {
        const anchorValid = await this.#verifyAnchor(config, store, stream)
        if (!anchorValid) {
          failed = true
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

  async #verifyAnchor(
    config: ResolvedAuditConfig,
    store: ReturnType<StoreManager['use']>,
    stream: string
  ): Promise<boolean> {
    const anchorsFile = config.chain.anchor?.anchorsFile
    if (!anchorsFile) {
      this.logger.warning('No anchorsFile configured; skipping anchor check')
      return true
    }

    if (!existsSync(anchorsFile)) {
      this.logger.warning(`Anchor file not found: ${anchorsFile}`)
      return true
    }

    const content = await readFile(anchorsFile, 'utf-8')
    const anchors: ChainHead[] = content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ChainHead)
      .filter((anchor) => anchor.stream === stream)
      .sort((a, b) => a.seq - b.seq)

    if (anchors.length === 0) {
      this.logger.warning(`No anchors found for stream "${stream}"`)
      return true
    }

    const latest = anchors[anchors.length - 1]!
    const head = await store.head(stream)

    if (!head) {
      this.logger.error(`Stream "${stream}" has anchors but no store head`)
      return false
    }

    if (head.seq < latest.seq) {
      this.logger.error(
        `Anchor ahead of store head in stream "${stream}": anchor seq ${latest.seq}, head seq ${head.seq}`
      )
      return false
    }

    if (head.seq === latest.seq && head.hash !== latest.hash) {
      this.logger.error(`Anchor hash mismatch in stream "${stream}" at seq ${latest.seq}`)
      return false
    }

    this.logger.log(`✓ stream="${stream}" anchor seq=${latest.seq} hash matched`)
    return true
  }
}
