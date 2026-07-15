import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { AssembleInput } from '../core/assembler.js'
import type { AuditActor } from '../types.js'
import type { AuditSubmissionSource } from './audit.js'
import type AuditService from './audit.js'

export default class LogBuilder {
  #service: AuditService
  #event: string
  #source: AuditSubmissionSource
  #auditableType?: string | null
  #auditableId?: string | null
  #oldValues?: Record<string, unknown> | null
  #newValues?: Record<string, unknown> | null
  #metadata?: Record<string, unknown> | null
  #tags: string[] = []
  #actor?: AuditActor | null
  #transaction?: TransactionClientContract

  constructor(service: AuditService, event: string, source: AuditSubmissionSource = 'domain') {
    this.#service = service
    this.#event = event
    this.#source = source
  }

  on(model: {
    constructor: { name: string; primaryKey?: string }
    $primaryKeyValue?: string | number
    $attributes?: Record<string, unknown>
    id?: string | number
  }): this {
    const primaryKey = model.constructor.primaryKey ?? 'id'
    const id = model.$attributes?.[primaryKey] ?? model.$primaryKeyValue ?? model.id
    if (id === undefined || id === null) {
      throw new Error(`Cannot audit ${model.constructor.name} without a primary key value`)
    }

    this.#auditableType = model.constructor.name
    this.#auditableId = String(id)
    return this
  }

  onRef(type: string, id: string): this {
    this.#auditableType = type
    this.#auditableId = id
    return this
  }

  withTransaction(transaction: TransactionClientContract): this {
    this.#transaction = transaction
    return this
  }

  by(actor: AuditActor): this {
    this.#actor = actor
    return this
  }

  withMeta(meta: Record<string, unknown>): this {
    this.#metadata = meta
    return this
  }

  withOld(old: Record<string, unknown>): this {
    this.#oldValues = old
    return this
  }

  withNew(newValue: Record<string, unknown>): this {
    this.#newValues = newValue
    return this
  }

  tag(...tags: string[]): this {
    this.#tags.push(...tags)
    return this
  }

  async commit(): Promise<void> {
    await this.#service.emitLog(this)
  }

  async commitSync(timeoutMs?: number): Promise<void> {
    await this.#service.emitLogSync(this, timeoutMs)
  }

  get event(): string {
    return this.#event
  }

  get source(): AuditSubmissionSource {
    return this.#source
  }

  get auditableType(): string | null {
    return this.#auditableType ?? null
  }

  get auditableId(): string | null {
    return this.#auditableId ?? null
  }

  get oldValues(): Record<string, unknown> | null {
    return this.#oldValues ?? null
  }

  get newValues(): Record<string, unknown> | null {
    return this.#newValues ?? null
  }

  get metadata(): Record<string, unknown> | null {
    return this.#metadata ?? null
  }

  get tags(): string[] {
    return this.#tags
  }

  get actor(): AuditActor | null {
    return this.#actor ?? null
  }

  get transaction(): TransactionClientContract | undefined {
    return this.#transaction
  }

  toAssembleInput(): AssembleInput {
    return {
      event: this.#event,
      auditableType: this.auditableType,
      auditableId: this.auditableId,
      oldValues: this.oldValues,
      newValues: this.newValues,
      metadata: this.metadata,
      tags: this.#tags,
      actor: this.#actor,
      transaction: this.#transaction,
    }
  }
}
