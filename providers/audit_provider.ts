import type { ApplicationService } from '@adonisjs/core/types'
import '../src/types/container_bindings.js'
import StoreManager from '../src/stores/store_manager.js'
import AuditPipeline from '../src/core/pipeline.js'
import AuditService from '../src/services/audit.js'
import { auditContext } from '../src/audit_context.js'
import { createRedactor } from '../src/core/redactor.js'

export default class AuditProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('audit.manager', async () => {
      const config = await this.app.container.make('audit.config')
      return new StoreManager(config)
    })

    this.app.container.singleton('audit.pipeline', async () => {
      const config = await this.app.container.make('audit.config')
      const manager = await this.app.container.make('audit.manager')
      return new AuditPipeline(config.queue, { store: manager.use() })
    })

    this.app.container.singleton('audit.redactor', async () => {
      const config = await this.app.container.make('audit.config')
      const salt = process.env[config.redaction.saltEnvVar]
      return createRedactor({
        paths: config.redaction.global,
        mode: config.redaction.mode,
        salt,
      })
    })

    this.app.container.singleton('audit', async () => {
      const config = await this.app.container.make('audit.config')
      const manager = await this.app.container.make('audit.manager')
      const pipeline = await this.app.container.make('audit.pipeline')
      return new AuditService(manager, pipeline, {
        assemble: {
          payloadMaxBytes: config.payloadMaxBytes,
          streamBy: config.chain.streamBy,
        },
        context: auditContext,
      })
    })
  }

  async boot() {
    // M3: wire Lucid hooks helper, auth listener
  }

  async start() {
    const pipeline = await this.app.container.make('audit.pipeline')
    pipeline.start()
  }

  async shutdown() {
    const pipeline = await this.app.container.make('audit.pipeline')
    await pipeline.shutdown(5000)
  }
}
