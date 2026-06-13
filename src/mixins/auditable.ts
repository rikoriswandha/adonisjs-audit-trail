import app from '@adonisjs/core/services/app'
import { type BaseModel } from '@adonisjs/lucid/orm'
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers'
import type { LucidModel, LucidRow, ModelObject } from '@adonisjs/lucid/types/model'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { AuditEvent, AuditableModelConfig, AuditRuntimeEvents } from '../types.js'
import type { ResolvedAuditConfig } from '../define_config.js'
import { assembleEvent } from '../core/assembler.js'
import { createRedactor } from '../core/redactor.js'
import { AuditPipelineRejectedError } from '../core/errors.js'
import { auditContext } from '../audit_context.js'
import Audit from '../models/audit.js'

type AuditableConstructor = LucidModel & {
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
      return Audit.query()
        .where('auditable_type', this.constructor.name)
        .where('auditable_id', String(getPrimaryKeyValue(this)))
    }

    async lastAudit() {
      return this.audits().orderBy('seq', 'desc').first()
    }
  }

  return AuditableModel as typeof superclass & { auditConfig?: AuditableModelConfig }
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
  const context = auditContext.get() ?? {}
  const localRedactor = buildLocalRedactor(modelConfig, config)
  const event = await assembleEvent(
    {
      event: `model.${kind}`,
      auditableType: getModelConstructor(model).name,
      auditableId: String(getPrimaryKeyValue(model)),
      oldValues: oldValues === null ? null : localRedactor(oldValues),
      newValues: newValues === null ? null : localRedactor(newValues),
      tags: modelConfig.tags ?? [],
    },
    context,
    {
      payloadMaxBytes: config.payloadMaxBytes,
      streamBy: config.chain.streamBy,
    }
  )

  await emitWithGuarantee({ event, strict: modelConfig.strict === true }, model, config)
}

async function emitWithGuarantee(
  emission: AuditEmission,
  model: LucidRow,
  config: ResolvedAuditConfig
): Promise<void> {
  try {
    const trx = model.$trx
    if (trx && config.guarantee === 'transactional-outbox') {
      await writeOutbox(trx, await redactForOutbox(emission.event))
      return
    }

    if (trx) {
      trx.after('commit', async () => {
        await enqueueEvent(emission.event)
      })
      return
    }

    await enqueueEvent(emission.event)
  } catch (error) {
    await emitAuditError(emission.event, error)
    if (emission.strict) throw error
  }
}

async function enqueueEvent(event: AuditEvent): Promise<void> {
  const pipeline = await app.container.make('audit.pipeline')
  const accepted = pipeline.enqueue(event)
  if (!accepted) {
    throw new AuditPipelineRejectedError()
  }
}

async function redactForOutbox(event: AuditEvent): Promise<AuditEvent> {
  const redactor = await app.container.make('audit.redactor')
  return {
    ...event,
    oldValues: event.oldValues === null ? null : redactor.redact(event.oldValues),
    newValues: event.newValues === null ? null : redactor.redact(event.newValues),
    metadata: event.metadata === null ? null : redactor.redact(event.metadata),
  }
}

async function writeOutbox(trx: TransactionClientContract, event: AuditEvent): Promise<void> {
  const now = new Date().toISOString()
  await trx
    .insertQuery()
    .table('audit_outbox')
    .insert({
      payload: JSON.stringify({ event }),
      attempts: 0,
      claimed_at: null,
      processed_at: null,
      created_at: now,
      updated_at: now,
    })
}

async function emitAuditError(event: AuditEvent | null, error: unknown): Promise<void> {
  try {
    const emitter = await app.container.make('emitter')
    await emitter.emit('audit:error', {
      event,
      error,
      source: 'model',
    } satisfies AuditRuntimeEvents['audit:error'])
  } catch {}
}

function buildUpdateSnapshot(model: LucidRow): UpdateSnapshot {
  const dirtyKeys = new Set(Object.keys(model.$dirty))
  const oldValues = serializeModel(model, dirtyKeys, model.$original)
  const newValues = serializeModel(model, dirtyKeys, model.$attributes)
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

function getModelConstructor(model: LucidRow): AuditableConstructor {
  return model.constructor as AuditableConstructor
}

function getPrimaryKeyValue(model: LucidRow): string | number {
  const primaryKey = getModelConstructor(model).primaryKey
  const value = model.$primaryKeyValue ?? model.$attributes[primaryKey]
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
