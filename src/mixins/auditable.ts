import app from '@adonisjs/core/services/app'
import { type BaseModel } from '@adonisjs/lucid/orm'
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers'
import type { LucidModel, LucidRow, ModelObject } from '@adonisjs/lucid/types/model'
import type { AuditEvent, AuditableModelConfig, AuditableModelInstance } from '../types.js'
import type { ResolvedAuditConfig } from '../define_config.js'
import { createRedactor } from '../core/redactor.js'
import { AuditTransactionRequiredError } from '../core/errors.js'
import Audit from '../models/audit.js'

type AuditableModelConstructor = LucidModel & {
  auditConfig?: AuditableModelConfig
}

type AuditableConstructor<T extends NormalizeConstructor<typeof BaseModel>> = Omit<
  T,
  'prototype'
> & {
  new (...args: ConstructorParameters<T>): InstanceType<T> & AuditableModelInstance
  auditConfig?: AuditableModelConfig
}

type ModelEventName = 'created' | 'updated' | 'deleted' | 'restored'

interface UpdateSnapshot {
  oldValues: Record<string, unknown>
  newValues: Record<string, unknown>
}

interface AuditEmission {
  event: AuditEvent
  strict: boolean
}

const registered = new WeakSet<object>()
const updateSnapshots = new WeakMap<LucidRow, UpdateSnapshot>()

export function Auditable<T extends NormalizeConstructor<typeof BaseModel>>(superclass: T) {
  class AuditableModel extends superclass {
    static auditConfig?: AuditableModelConfig

    static override boot() {
      super.boot()
      if (registered.has(this)) return

      registered.add(this)
      this.before('update', (model) => {
        updateSnapshots.set(model, buildUpdateSnapshot(model))
      })
      this.after('create', (model) => captureModelEvent('created', model))
      this.after('update', (model) => captureUpdateEvent(model))
      this.after('delete', (model) => captureModelEvent('deleted', model))
    }

    audits() {
      const query = this.$trx
        ? Audit.query({ client: this.$trx })
        : Audit.query({ connection: this.$options?.connection })
      return query.withScopes((scopes) => scopes.forModel(this))
    }

    async lastAudit() {
      return this.audits().orderBy('seq', 'desc').first()
    }
  }

  return AuditableModel as unknown as AuditableConstructor<T>
}

async function captureUpdateEvent(model: LucidRow): Promise<void> {
  const snapshot = updateSnapshots.get(model)
  updateSnapshots.delete(model)

  if (!snapshot || Object.keys(snapshot.newValues).length === 0) {
    return
  }

  const config = getConfig(model)
  const restored =
    Object.hasOwn(snapshot.oldValues, 'deletedAt') &&
    snapshot.oldValues.deletedAt !== null &&
    snapshot.oldValues.deletedAt !== undefined &&
    snapshot.newValues.deletedAt === null

  if (restored && isEnabled(config, 'restored')) {
    await emitModelEvent('restored', model, snapshot.oldValues, snapshot.newValues)
    return
  }

  if (isEnabled(config, 'updated')) {
    await emitModelEvent('updated', model, snapshot.oldValues, snapshot.newValues)
  }
}

async function captureModelEvent(
  kind: Exclude<ModelEventName, 'updated' | 'restored'>,
  model: LucidRow
) {
  const config = getConfig(model)
  if (!isEnabled(config, kind)) return

  const snapshot = serializeModel(model)
  const oldValues = kind === 'deleted' ? snapshot : null
  const newValues = kind === 'created' ? snapshot : null
  await emitModelEvent(kind, model, oldValues, newValues)
}

async function emitModelEvent(
  kind: ModelEventName,
  model: LucidRow,
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null
): Promise<void> {
  const modelConfig = getConfig(model)
  const config = await app.container.make('audit.config')
  const audit = await app.container.make('audit')
  const localRedactor = buildLocalRedactor(modelConfig, config)
  const event = await audit.assemble({
    event: `model.${kind}`,
    auditableType: getModelConstructor(model).name,
    auditableId: String(getPrimaryKeyValue(model)),
    oldValues: oldValues === null ? null : localRedactor(oldValues),
    newValues: newValues === null ? null : localRedactor(newValues),
    tags: modelConfig.tags ?? [],
    transaction: model.$trx,
  })

  await emitWithGuarantee({ event, strict: modelConfig.strict === true }, model, config)
}

async function emitWithGuarantee(
  emission: AuditEmission,
  model: LucidRow,
  config: ResolvedAuditConfig
): Promise<void> {
  try {
    const audit = await app.container.make('audit')
    if (model.$trx && config.guarantee !== 'transactional-outbox') {
      model.$trx.after('commit', async () => {
        try {
          await audit.submit(emission.event, { source: 'model' })
        } catch {}
      })
      return
    }

    await audit.submit(emission.event, {
      transaction: model.$trx,
      source: 'model',
    })
  } catch (error) {
    if (!model.$trx || emission.strict || error instanceof AuditTransactionRequiredError)
      throw error
  }
}

function buildUpdateSnapshot(model: LucidRow): UpdateSnapshot {
  const dirtyKeys = new Set(Object.keys(model.$dirty))
  const config = getConfig(model)
  const onlyKeys = config.snapshot === 'full' ? undefined : dirtyKeys
  const oldValues = serializeModel(model, onlyKeys, model.$original)
  const newValues = serializeModel(model, onlyKeys, model.$attributes)
  return removeExcluded(model, oldValues, newValues)
}

function removeExcluded(
  model: LucidRow,
  oldValues: Record<string, unknown>,
  newValues: Record<string, unknown>
): UpdateSnapshot {
  const excluded = new Set(getConfig(model).exclude ?? [])
  if (excluded.size === 0) return { oldValues, newValues }

  const filteredOld: Record<string, unknown> = {}
  const filteredNew: Record<string, unknown> = {}
  for (const key of Object.keys(newValues)) {
    if (excluded.has(key)) continue
    filteredOld[key] = oldValues[key]
    filteredNew[key] = newValues[key]
  }

  return { oldValues: filteredOld, newValues: filteredNew }
}

function serializeModel(
  model: LucidRow,
  onlyKeys?: Set<string>,
  source: ModelObject = model.$attributes
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const excluded = new Set(getConfig(model).exclude ?? [])
  const modelConstructor = getModelConstructor(model)

  for (const [attribute, column] of modelConstructor.$columnsDefinitions) {
    if (column.serializeAs === null) continue
    if (excluded.has(attribute)) continue
    if (onlyKeys && !onlyKeys.has(attribute)) continue
    output[attribute] = serializeValue(source[attribute])
  }

  return output
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (hasToISO(value)) return value.toISO()
  if (Array.isArray(value)) return value.map((item) => serializeValue(item))
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      output[key] = serializeValue(child)
    }
    return output
  }
  return value
}

function buildLocalRedactor(
  modelConfig: AuditableModelConfig,
  config: ResolvedAuditConfig
): (value: Record<string, unknown>) => Record<string, unknown> {
  if (!modelConfig.redact || modelConfig.redact.length === 0) {
    return (value) => value
  }

  const redactor = createRedactor({
    paths: modelConfig.redact,
    mode: config.redaction.mode,
    salt: process.env[config.redaction.saltEnvVar],
  })
  return (value) => redactor.redact(value)
}

function isEnabled(config: AuditableModelConfig, event: ModelEventName): boolean {
  return (config.events ?? ['created', 'updated', 'deleted']).includes(event)
}

function getConfig(model: LucidRow): AuditableModelConfig {
  return getModelConstructor(model).auditConfig ?? {}
}

function getModelConstructor(model: LucidRow): AuditableModelConstructor {
  return model.constructor as AuditableModelConstructor
}

function getPrimaryKeyValue(model: LucidRow): string | number {
  const modelConstructor = getModelConstructor(model)
  const primaryKey =
    [...modelConstructor.$columnsDefinitions].find(([, column]) => column.isPrimary)?.[0] ??
    modelConstructor.primaryKey
  const value = model.$attributes[primaryKey] ?? model.$primaryKeyValue
  return value as string | number
}

function hasToISO(value: unknown): value is { toISO: () => string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toISO' in value &&
    typeof value.toISO === 'function'
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && value.constructor === Object
}
