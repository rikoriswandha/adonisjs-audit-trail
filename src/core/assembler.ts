import { createHash } from 'node:crypto'
import type { AuditActor, AuditEvent } from '../types.js'
import type { AuditContextStore } from '../audit_context.js'
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
}

export interface AssembleConfig {
  payloadMaxBytes: number
  streamBy: 'global' | 'tenant' | ((event: AuditEvent) => string)
  tenantId?: string | null
  environment?: string
  crypto?: { encrypt: (event: AuditEvent) => Promise<AuditEvent> }
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function resolveStream(
  input: AssembleInput,
  context: AuditContextStore,
  config: AssembleConfig
): string {
  if (config.streamBy === 'global') {
    return 'default'
  }

  if (config.streamBy === 'tenant') {
    return context.tenantId ?? config.tenantId ?? 'default'
  }

  const partialEvent = {
    event: input.event,
    auditableType: input.auditableType ?? null,
    auditableId: input.auditableId ?? null,
    tenantId: context.tenantId ?? config.tenantId ?? null,
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
export async function assembleEvent(
  input: AssembleInput,
  context: AuditContextStore,
  config: AssembleConfig
): Promise<AuditEvent> {
  const actor = input.actor ?? (await resolveActor(context, config.environment))
  const tenantId = context.tenantId ?? config.tenantId ?? null
  const oldValues = maybeTruncate(input.oldValues ?? null, config.payloadMaxBytes)
  const newValues = maybeTruncate(input.newValues ?? null, config.payloadMaxBytes)
  const metadata = maybeTruncate(input.metadata ?? null, config.payloadMaxBytes)

  let event: AuditEvent = {
    id: uuidv7(),
    event: input.event,
    stream: resolveStream(input, context, config),
    auditableType: input.auditableType ?? null,
    auditableId: input.auditableId ?? null,
    oldValues,
    newValues,
    metadata,
    actor,
    tenantId,
    requestId: context.requestId ?? null,
    correlationId: context.correlationId ?? null,
    ipAddress: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    url: context.url ?? null,
    httpMethod: context.httpMethod ?? null,
    tags: input.tags ?? [],
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
  }

  if (config.crypto) {
    event = await config.crypto.encrypt(event)
  }

  return event
}
