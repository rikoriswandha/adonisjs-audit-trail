import type { ApplicationService } from '@adonisjs/core/types'
import StoreManager from '../src/stores/store_manager.js'
import AuditPipeline from '../src/core/pipeline.js'
import AuditService from '../src/services/audit.js'

export default class AuditProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('audit.manager', async () => {
      const auditConfig = await this.app.container.make('audit.config')
      return new StoreManager(auditConfig)
    })

    this.app.container.singleton('audit.pipeline', async () => {
      return new AuditPipeline()
    })

    this.app.container.singleton('audit', async () => {
      return new AuditService(
        await this.app.container.make('audit.manager'),
        await this.app.container.make('audit.pipeline')
      )
    })
  }

  async boot() {
    // M2: wire Lucid hooks helper, auth listener
  }

  async start() {
    // M2: start flusher, start outbox drainer
  }

  async shutdown() {
    // M2: final flush with deadline
  }
}
