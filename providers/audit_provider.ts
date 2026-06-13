import { configProvider } from '@adonisjs/core'
import type { ApplicationService } from '@adonisjs/core/types'
import type { ResolvedAuditConfig } from '../src/define_config.js'
import AuthListener from '../src/listeners/auth_listener.js'
import '../src/types/container_bindings.js'
import StoreManager from '../src/stores/store_manager.js'
import AuditPipeline from '../src/core/pipeline.js'
import AuditOutboxDrainer from '../src/core/outbox_drainer.js'
import AuditService from '../src/services/audit.js'
import { auditContext } from '../src/audit_context.js'
import { createRedactor } from '../src/core/redactor.js'
import { AnchorService } from '../src/core/anchor.js'
import { createSubjectCrypto } from '../src/core/subject_crypto.js'

function resolveAuditConfig(app: ApplicationService): Promise<ResolvedAuditConfig> {
  const provider = app.config.get('audit')
  return configProvider.resolve(app, provider) as Promise<ResolvedAuditConfig>
}
export default class AuditProvider {
  #outboxDrainer?: AuditOutboxDrainer

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('audit.config', async () => {
      return resolveAuditConfig(this.app)
    })

    this.app.container.singleton('audit.manager', async () => {
      const config = await this.app.container.make('audit.config')
      return new StoreManager(config)
    })

    this.app.container.singleton('audit.pipeline', async () => {
      const config = await this.app.container.make('audit.config')
      const manager = await this.app.container.make('audit.manager')
      const redactor = await this.app.container.make('audit.redactor')
      const dlqPath = this.app.makePath('storage/audit-dlq')
      const emitter = await this.app.container.make('emitter')

      return new AuditPipeline(config.queue, {
        store: manager.use(),
        storeName: manager.default,
        routeStore: (event) => manager.route(event),
        redactor,
        deadLetterHandler: AuditPipeline.createFileDeadLetterHandler(dlqPath),
        emitter,
      })
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

    this.app.container.singleton('audit.outbox_drainer', async () => {
      const manager = await this.app.container.make('audit.manager')
      return new AuditOutboxDrainer(this.app, manager.use())
    })

    this.app.container.singleton('audit', async () => {
      const config = await this.app.container.make('audit.config')
      const manager = await this.app.container.make('audit.manager')
      const pipeline = await this.app.container.make('audit.pipeline')
      const crypto = createSubjectCrypto(config.cryptoShredding)
      return new AuditService(manager, pipeline, {
        assemble: {
          payloadMaxBytes: config.payloadMaxBytes,
          streamBy: config.chain.streamBy,
          ...(crypto ? { crypto } : {}),
        },
        context: auditContext,
        guarantee: config.guarantee,
      })
    })
  }

  async boot() {}

  async start() {
    const config = await this.app.container.make('audit.config')
    const emitter = await this.app.container.make('emitter')

    if (config.captureAuthEvents) {
      const audit = await this.app.container.make('audit')
      this.#authListener = new AuthListener(emitter, audit)
      this.#authListener.attach()
    }

    const pipeline = await this.app.container.make('audit.pipeline')
    pipeline.start()

    if (config.chain.anchor) {
      const anchorService = new AnchorService(config.chain.anchor)
      emitter.on('audit:flushed', (payload) => {
        anchorService.onFlush(payload.events).catch(() => {})
      })
    }

    if (config.guarantee === 'transactional-outbox') {
      this.#outboxDrainer = await this.app.container.make('audit.outbox_drainer')
      await this.#outboxDrainer.drain()
      this.#outboxDrainer.start()
    }
  }

  async shutdown() {
    this.#authListener?.detach()
    this.#outboxDrainer?.stop()
    const pipeline = await this.app.container.make('audit.pipeline')
    await pipeline.shutdown(5000)
  }

  #authListener?: AuthListener
}
