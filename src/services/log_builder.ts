import type { AuditActor } from '../types.js'
import type AuditService from './audit.js'

export default class LogBuilder {
  #service: AuditService
  #event: string
  #auditableType?: string | null
  #auditableId?: string | null
  #oldValues?: Record<string, unknown> | null
  #newValues?: Record<string, unknown> | null
  #metadata?: Record<string, unknown> | null
  #tags: string[] = []
  #actor?: AuditActor | null

  constructor(service: AuditService, event: string) {
    this.#service = service
    this.#event = event
  }

  on(model: { constructor: { name: string }; id: string | number }): this {
    this.#auditableType = model.constructor.name
    this.#auditableId = String(model.id)
    return this
  }

  onRef(type: string, id: string): this {
    this.#auditableType = type
    this.#auditableId = id
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

  toAssembleInput(): {
    event: string
    auditableType: string | null
    auditableId: string | null
    oldValues: Record<string, unknown> | null
    newValues: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
    tags: string[]
    actor?: AuditActor | null
  } {
    return {
      event: this.#event,
      auditableType: this.auditableType,
      auditableId: this.auditableId,
      oldValues: this.oldValues,
      newValues: this.newValues,
      metadata: this.metadata,
      tags: this.#tags,
      actor: this.#actor,
    }
  }
}
