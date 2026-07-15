import { createHash } from 'node:crypto'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { AuditActor, AuditEvent } from '../types.js'
import type { AuditContextStore } from '../audit_context.js'
import { AuditConfigurationError } from './errors.js'
import { uuidv7 } from './uuidv7.js'

export interface AssembleInput {
  event: string
  auditableType?: string | null
  auditableId?: string | null
  oldValues?: Record<string, unknown> | null
  newValues?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
  tags?: string[]
  actor?: AuditActor | null
  transaction?: TransactionClientContract
}

export interface AssembleConfig {
  payloadMaxBytes: number
  streamBy: 'global' | 'tenant' | ((event: AuditEvent) => string)
  tenantId?: string | null
  environment?: string
  crypto?: {
    encrypt: (event: AuditEvent, client?: TransactionClientContract) => Promise<AuditEvent>
  }
  redactor?: { redact: (values: Record<string, unknown>) => Record<string, unknown> }
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolveTenantId(context: AuditContextStore, config: AssembleConfig): string | null {
  const tenantId = context.tenantId ?? config.tenantId ?? null

  if (tenantId === null) {
    return null
  }

  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.trim() !== tenantId) {
    throw new AuditConfigurationError('Audit tenant IDs must be non-empty, trimmed strings')
  }

  return tenantId
}

function resolveStream(
  input: AssembleInput,
  config: AssembleConfig,
  tenantId: string | null
): string {
  if (config.streamBy === 'global') {
    return 'default'
  }

  if (config.streamBy === 'tenant') {
    if (tenantId === null) {
      throw new AuditConfigurationError('Tenant stream mode requires a tenant ID')
    }
    return tenantId
  }

  const partialEvent = {
    event: input.event,
    auditableType: input.auditableType ?? null,
    auditableId: input.auditableId ?? null,
    tenantId,
    actor: { type: 'system', id: null } as AuditActor,
    oldValues: input.oldValues ?? null,
    newValues: input.newValues ?? null,
    metadata: input.metadata ?? null,
  } as AuditEvent

  return config.streamBy(partialEvent)
}

async function resolveActor(context: AuditContextStore, environment?: string): Promise<AuditActor> {
  if (!context.actor) {
    return { type: environment === 'console' ? 'cli' : 'system', id: null }
  }

  if (typeof context.actor === 'function') {
    const actor = await context.actor()
    return actor ?? { type: environment === 'console' ? 'cli' : 'system', id: null }
  }

  return context.actor
}

function maybeTruncate(
  values: Record<string, unknown> | null,
  payloadMaxBytes: number
): Record<string, unknown> | null {
  if (values === null) {
    return null
  }

  const serialized = JSON.stringify(values)
  if (Buffer.byteLength(serialized, 'utf8') <= payloadMaxBytes) {
    return values
  }

  return {
    _truncated: true,
    _sha256: sha256(serialized),
  }
}

function truncatePayloads(event: AuditEvent, payloadMaxBytes: number): AuditEvent {
  return {
    ...event,
    oldValues: maybeTruncate(event.oldValues, payloadMaxBytes),
    newValues: maybeTruncate(event.newValues, payloadMaxBytes),
    metadata: maybeTruncate(event.metadata, payloadMaxBytes),
  }
}

export async function assembleEvent(
  input: AssembleInput,
  context: AuditContextStore,
  config: AssembleConfig
): Promise<AuditEvent> {
  const actor = input.actor ?? (await resolveActor(context, config.environment))
  const tenantId = resolveTenantId(context, config)

  let event: AuditEvent = {
    id: uuidv7(),
    event: input.event,
    stream: resolveStream(input, config, tenantId),
    auditableType: input.auditableType ?? null,
    auditableId: input.auditableId ?? null,
    oldValues: input.oldValues ?? null,
    newValues: input.newValues ?? null,
    metadata: input.metadata ?? null,
    actor,
    tenantId,
    requestId: context.requestId ?? null,
    correlationId: context.correlationId ?? null,
    ipAddress: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    url: context.url?.replace(/\?.*$/, '') ?? null,
    httpMethod: context.httpMethod ?? null,
    tags: input.tags ?? [],
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
  }

  if (config.redactor) {
    event = {
      ...event,
      oldValues: event.oldValues ? config.redactor.redact(event.oldValues) : event.oldValues,
      newValues: event.newValues ? config.redactor.redact(event.newValues) : event.newValues,
      metadata: event.metadata ? config.redactor.redact(event.metadata) : event.metadata,
    }
  }

  if (config.crypto) {
    event = await config.crypto.encrypt(event, input.transaction)
  }

  return truncatePayloads(event, config.payloadMaxBytes)
}
