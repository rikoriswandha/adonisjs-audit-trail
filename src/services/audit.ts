import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type {
  AuditEvent,
  AuditRuntimeEvents,
  GuaranteeMode,
  KnownAuditEvent,
  PipelineStats,
} from '../types.js'
import type { AuditContextStore, auditContext as AuditContext } from '../audit_context.js'
import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'
import type { AssembleConfig, AssembleInput } from '../core/assembler.js'
import { assembleEvent } from '../core/assembler.js'
import { AuditDroppedError, AuditTransactionRequiredError } from '../core/errors.js'
import { uuidv7 } from '../core/uuidv7.js'
import LogBuilder from './log_builder.js'

export type AuditSubmissionSource = 'domain' | 'model' | 'auth'

export interface AuditSubmissionOptions {
  transaction?: TransactionClientContract
  source?: AuditSubmissionSource
}

export interface AuditServiceConfig {
  assemble: AssembleConfig
  context: typeof AuditContext
  guarantee: GuaranteeMode
  outbox?: { table?: string }
  emitter?: {
    emit<Name extends keyof AuditRuntimeEvents>(
      event: Name,
      payload: AuditRuntimeEvents[Name]
    ): Promise<void>
  }
}

export default class AuditService {
  constructor(
    protected manager: StoreManager,
    protected pipeline: AuditPipeline,
    protected config: AuditServiceConfig
  ) {}

  log(event: KnownAuditEvent, source: AuditSubmissionSource = 'domain'): LogBuilder {
    return new LogBuilder(this, String(event), source)
  }

  withinContext<T>(store: Partial<AuditContextStore>, fn: () => T): T {
    return this.config.context.run(store, fn)
  }

  stats(): PipelineStats {
    return this.pipeline.stats()
  }

  async emit(event: AuditEvent): Promise<void> {
    await this.submit(event)
  }

  async submit(event: AuditEvent, options: AuditSubmissionOptions = {}): Promise<void> {
    await this.#submit(event, options)
  }

  async assemble(input: AssembleInput): Promise<AuditEvent> {
    const context = this.config.context.get() ?? {}
    return assembleEvent(input, context, this.config.assemble)
  }

  async emitLog(builder: LogBuilder): Promise<void> {
    const event = await this.#assembleBuilderEvent(builder)
    await this.submit(event, {
      transaction: builder.transaction,
      source: builder.source,
    })
  }

  async emitLogSync(builder: LogBuilder, timeoutMs?: number): Promise<void> {
    const event = await this.#assembleBuilderEvent(builder)
    await this.#submit(
      event,
      {
        transaction: builder.transaction,
        source: builder.source,
      },
      timeoutMs,
      true
    )
  }

  async #submit(
    event: AuditEvent,
    { transaction, source = 'domain' }: AuditSubmissionOptions,
    timeoutMs?: number,
    forceCoupled = false
  ): Promise<void> {
    try {
      if (this.config.guarantee === 'transactional-outbox') {
        if (!transaction) {
          throw new AuditTransactionRequiredError()
        }

        await transaction
          .insertQuery()
          .table(this.config.outbox?.table ?? 'audit_outbox')
          .insert({
            id: uuidv7(),
            payload: JSON.stringify({ event }),
            tenant_id: event.tenantId,
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            claimed_at: null,
            processed_at: null,
            failed_at: null,
            last_error: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
        return
      }

      const accepted = await this.pipeline.enqueue(event)
      if (!accepted) {
        if (this.config.guarantee !== 'best-effort') {
          throw new AuditDroppedError()
        }
        return
      }

      if (forceCoupled || this.config.guarantee === 'request-coupled') {
        await this.pipeline.requestCoupledFlush([event.id], timeoutMs)
      }
    } catch (error) {
      await this.#reportError(event, error, source)
      throw error
    }
  }

  async #assembleBuilderEvent(builder: LogBuilder): Promise<AuditEvent> {
    return this.assemble(builder.toAssembleInput())
  }

  async #reportError(
    event: AuditEvent,
    error: unknown,
    source: AuditSubmissionSource
  ): Promise<void> {
    try {
      await this.config.emitter?.emit('audit:error', { event, error, source })
    } catch {}
  }
}
