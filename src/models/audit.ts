import { BaseModel, column, scope } from '@adonisjs/lucid/orm'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type {
  LucidModel,
  ModelAdapterOptions,
  ModelQueryBuilderContract,
} from '@adonisjs/lucid/types/model'
import type { DateTime } from 'luxon'
import { AuditImmutableError } from '../core/errors.js'

export default class Audit extends BaseModel {
  static table = 'audits'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare seq: number

  @column()
  declare stream: string

  @column()
  declare event: string

  @column()
  declare auditableType: string | null

  @column()
  declare auditableId: string | null

  @column({
    prepare: (value: unknown) => JSON.stringify(value),
    consume: (value: string | null) => (value === null ? null : JSON.parse(value)),
  })
  declare oldValues: Record<string, unknown> | null

  @column({
    prepare: (value: unknown) => JSON.stringify(value),
    consume: (value: string | null) => (value === null ? null : JSON.parse(value)),
  })
  declare newValues: Record<string, unknown> | null

  @column({
    prepare: (value: unknown) => JSON.stringify(value),
    consume: (value: string | null) => (value === null ? null : JSON.parse(value)),
  })
  declare metadata: Record<string, unknown> | null

  @column()
  declare actorType: string

  @column()
  declare actorId: string | null

  @column()
  declare actorLabel: string | null

  @column()
  declare tenantId: string | null

  @column()
  declare requestId: string | null

  @column()
  declare correlationId: string | null

  @column()
  declare ipAddress: string | null

  @column()
  declare userAgent: string | null

  @column()
  declare url: string | null

  @column()
  declare httpMethod: string | null

  @column({
    prepare: (value: unknown) => JSON.stringify(value),
    consume: (value: string | null) => (value === null ? [] : JSON.parse(value)),
  })
  declare tags: string[]

  @column()
  declare schemaVersion: string

  @column()
  declare hash: string

  @column()
  declare prevHash: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  static forModel = scope(
    (query, model: { constructor: { name: string }; id: string | number }) => {
      query.where('auditable_type', model.constructor.name).where('auditable_id', String(model.id))
    }
  )

  static forRef = scope((query, type: string, id: string) => {
    query.where('auditable_type', type).where('auditable_id', id)
  })

  static byActor = scope(
    (query, actor: { id: string | number; constructor?: { name?: string } }) => {
      const type = actor.constructor?.name ?? 'user'
      query.where('actor_type', type).where('actor_id', String(actor.id))
    }
  )

  static inTenant = scope((query, id: string) => {
    query.where('tenant_id', id)
  })

  static between = scope((query, from: Date | string | DateTime, to: Date | string | DateTime) => {
    const fromIso = Audit.#toIso(from)
    const toIso = Audit.#toIso(to)
    query.where('created_at', '>=', fromIso).where('created_at', '<=', toIso)
  })

  static event = scope((query, name: string) => {
    query.where('event', name)
  })

  static #toIso(value: Date | string | DateTime): string {
    if (typeof value === 'string') return value
    if (value instanceof Date) return value.toISOString()
    return value.toISO() as string
  }

  static query<Model extends LucidModel, Result = InstanceType<Model>>(
    this: Model,
    options?: ModelAdapterOptions
  ): ModelQueryBuilderContract<Model, Result> {
    const query = super.query(options) as ModelQueryBuilderContract<Model, Result>
    let proxy: ModelQueryBuilderContract<Model, Result>

    const handler: ProxyHandler<ModelQueryBuilderContract<Model, Result>> = {
      get(target, property, receiver) {
        if (property === 'update' || property === 'del' || property === 'delete') {
          return () => {
            throw new AuditImmutableError()
          }
        }

        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof value !== 'function') {
          return value
        }

        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args) as unknown
          return result === target ? proxy : result
        }
      },
    }

    proxy = new Proxy(query, handler)
    return proxy
  }

  static async truncate(): Promise<void> {
    throw new AuditImmutableError()
  }

  $getQueryFor(
    action: 'insert',
    client: QueryClientContract
  ): ReturnType<QueryClientContract['insertQuery']>
  $getQueryFor(
    action: 'update' | 'delete' | 'refresh',
    client: QueryClientContract
  ): ModelQueryBuilderContract<LucidModel>
  $getQueryFor(
    action: 'insert' | 'update' | 'delete' | 'refresh',
    client: QueryClientContract
  ): ReturnType<QueryClientContract['insertQuery']> | ModelQueryBuilderContract<LucidModel> {
    if (action === 'update' || action === 'delete') {
      throw new AuditImmutableError()
    }

    if (action === 'insert') {
      return super.$getQueryFor(action, client)
    }

    return super.$getQueryFor(action, client)
  }

  async save(): Promise<this> {
    throw new AuditImmutableError()
  }

  async delete(): Promise<void> {
    throw new AuditImmutableError()
  }
}
