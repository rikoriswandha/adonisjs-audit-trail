import type { ApplicationService } from '@adonisjs/core/types'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { AuditEvent, AuditOutboxConfig, AuditStoreContract } from '../types.js'
import type { SuccessfulDeliveryNotifier } from './successful_delivery_notifier.js'
import { AuditOutboxPayloadError } from './errors.js'

const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_DELAY_MS = 0
const DEFAULT_OUTBOX_TABLE = 'audit_outbox'

type OutboxStatus = 'pending' | 'processing' | 'processed' | 'failed'

interface OutboxRow {
  id: string
  payload: unknown
  tenant_id: string | null
  status: OutboxStatus
  attempts: number | string | null
  available_at: unknown
  claimed_at: unknown
}

export interface OutboxMetrics {
  pending: number
  failed: number
  oldestPendingAgeMs: number | null
  attempts: number
}

type PoisonHandler = (info: {
  id: string
  payload: unknown
  attempts: number
  error: string
}) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload

  try {
    return JSON.parse(payload) as unknown
  } catch {
    throw new AuditOutboxPayloadError('Outbox payload is not valid JSON')
  }
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value)
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!isRecord(value) || !isRecord(value.actor)) return false

  return (
    typeof value.id === 'string' &&
    typeof value.event === 'string' &&
    typeof value.stream === 'string' &&
    isNullableString(value.auditableType) &&
    isNullableString(value.auditableId) &&
    isNullableRecord(value.oldValues) &&
    isNullableRecord(value.newValues) &&
    isNullableRecord(value.metadata) &&
    typeof value.actor.type === 'string' &&
    isNullableString(value.actor.id) &&
    (value.actor.label === undefined || isNullableString(value.actor.label)) &&
    isNullableString(value.tenantId) &&
    isNullableString(value.requestId) &&
    isNullableString(value.correlationId) &&
    isNullableString(value.ipAddress) &&
    isNullableString(value.userAgent) &&
    isNullableString(value.url) &&
    isNullableString(value.httpMethod) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    value.schemaVersion === '1' &&
    typeof value.createdAt === 'string'
  )
}

function normalizePayload(payload: unknown): AuditEvent[] {
  const value = parseJsonPayload(payload)
  const events = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.events)
      ? value.events
      : isRecord(value) && isAuditEvent(value.event)
        ? [value.event]
        : [value]

  if (events.length === 0 || !events.every(isAuditEvent)) {
    throw new AuditOutboxPayloadError('Outbox payload contains an invalid audit event')
  }

  return events
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export default class AuditOutboxDrainer {
  #timer: ReturnType<typeof setInterval> | null = null
  #staleClaimMs: number
  #maxAttempts: number
  #retryDelayMs: number
  #table: string
  #connection?: string
  #executor?: AuditOutboxConfig['executor']
  #onPoison: PoisonHandler

  constructor(
    protected app: ApplicationService,
    protected store: AuditStoreContract,
    options: AuditOutboxConfig,
    protected notifier: SuccessfulDeliveryNotifier,
    onPoison: PoisonHandler = defaultPoisonHandler
  ) {
    this.#staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.#table = options.table ?? DEFAULT_OUTBOX_TABLE
    this.#connection = options.connection
    this.#executor = options.executor
    this.#onPoison = onPoison
  }

  start(intervalMs = 1000): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      void this.drain()
    }, intervalMs)
    this.#timer.unref()
  }

  stop(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  async drain(limit = 100): Promise<number> {
    const db = await this.#sourceDb()
    if (!(await db.schema.hasTable(this.#table))) return 0

    const now = new Date()
    const staleHorizon = new Date(now.getTime() - this.#staleClaimMs)
    const rows = (await db
      .query()
      .from(this.#table)
      .where((builder) => {
        void builder
          .where((pending) => {
            void pending.where('status', 'pending').andWhere('available_at', '<=', now)
          })
          .orWhere((processing) => {
            void processing.where('status', 'processing').andWhere('claimed_at', '<', staleHorizon)
          })
      })
      .orderBy('available_at', 'asc')
      .limit(limit)) as OutboxRow[]

    let processed = 0
    for (const row of rows) {
      const claimedAt = new Date()
      const attempts = Number(row.attempts ?? 0) + 1
      if (!(await this.#claim(row, claimedAt, attempts))) continue

      let events: AuditEvent[]
      try {
        events = normalizePayload(row.payload)
      } catch (error) {
        await this.#fail(row, attempts, error, true)
        continue
      }

      try {
        const delivered = await this.store.write(events)
        await this.notifier.notify(this.store, delivered)
        await this.#ack(row)
        processed++
      } catch (error) {
        await this.#fail(row, attempts, error, false)
      }
    }

    return processed
  }

  async requeue(limit = 100): Promise<number> {
    const db = await this.#sourceDb()
    if (!(await db.schema.hasTable(this.#table))) return 0

    const rows = (await db
      .query()
      .select('id', 'tenant_id')
      .from(this.#table)
      .where('status', 'failed')
      .orderBy('failed_at', 'asc')
      .limit(limit)) as Pick<OutboxRow, 'id' | 'tenant_id'>[]

    let requeued = 0
    for (const row of rows) {
      const changed = await this.#withSource(row.tenant_id, async (client) => {
        return client
          .query()
          .from(this.#table)
          .where('id', row.id)
          .where('status', 'failed')
          .update({
            status: 'pending',
            attempts: 0,
            available_at: new Date(),
            claimed_at: null,
            failed_at: null,
            last_error: null,
            updated_at: new Date(),
          })
      })
      if (Number(changed) > 0) requeued++
    }

    return requeued
  }

  async stats(): Promise<OutboxMetrics> {
    const db = await this.#sourceDb()
    if (!(await db.schema.hasTable(this.#table))) {
      return { pending: 0, failed: 0, oldestPendingAgeMs: null, attempts: 0 }
    }

    const rows = (await db
      .query()
      .from(this.#table)
      .select('status', 'attempts', 'available_at')) as Pick<
      OutboxRow,
      'status' | 'attempts' | 'available_at'
    >[]
    const pendingRows = rows.filter((row) => row.status === 'pending')
    const oldestPending = pendingRows
      .map((row) => asDate(row.available_at))
      .filter((value): value is Date => value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0]

    return {
      pending: pendingRows.length,
      failed: rows.filter((row) => row.status === 'failed').length,
      attempts: rows.reduce((total, row) => total + Number(row.attempts ?? 0), 0),
      oldestPendingAgeMs: oldestPending ? Math.max(0, Date.now() - oldestPending.getTime()) : null,
    }
  }

  async #claim(row: OutboxRow, claimedAt: Date, attempts: number): Promise<boolean> {
    const staleHorizon = new Date(claimedAt.getTime() - this.#staleClaimMs)
    const affected = await this.#withSource(row.tenant_id, async (client) => {
      return client
        .query()
        .from(this.#table)
        .where('id', row.id)
        .where((builder) => {
          void builder
            .where((pending) => {
              void pending.where('status', 'pending').andWhere('available_at', '<=', claimedAt)
            })
            .orWhere((processing) => {
              void processing
                .where('status', 'processing')
                .andWhere('claimed_at', '<', staleHorizon)
            })
        })
        .update({
          status: 'processing',
          attempts,
          claimed_at: claimedAt,
          updated_at: claimedAt,
        })
    })

    return Number(affected) > 0
  }

  async #ack(row: OutboxRow): Promise<void> {
    const processedAt = new Date()
    await this.#withSource(row.tenant_id, async (client) => {
      await client
        .query()
        .from(this.#table)
        .where('id', row.id)
        .where('status', 'processing')
        .update({
          status: 'processed',
          processed_at: processedAt,
          updated_at: processedAt,
          last_error: null,
        })
    })
  }

  async #fail(row: OutboxRow, attempts: number, error: unknown, terminal: boolean): Promise<void> {
    const failed = terminal || attempts >= this.#maxAttempts
    const now = new Date()
    const message = errorMessage(error)

    await this.#withSource(row.tenant_id, async (client) => {
      await client
        .query()
        .from(this.#table)
        .where('id', row.id)
        .where('status', 'processing')
        .update(
          failed
            ? {
                status: 'failed',
                failed_at: now,
                last_error: message,
                updated_at: now,
              }
            : {
                status: 'pending',
                available_at: new Date(now.getTime() + this.#retryDelayMs),
                claimed_at: null,
                last_error: message,
                updated_at: now,
              }
        )
    })

    if (failed) {
      this.#onPoison({ id: row.id, payload: row.payload, attempts, error: message })
    }
  }

  async #withSource<T>(
    tenantId: string | null,
    operation: (client: QueryClientContract | TransactionClientContract) => Promise<T>
  ): Promise<T> {
    if (this.#executor) {
      return this.#executor(tenantId, operation)
    }
    return operation(await this.#sourceDb())
  }

  async #sourceDb(): Promise<QueryClientContract> {
    const db = await this.app.container.make('lucid.db')
    return this.#connection ? db.connection(this.#connection) : db.connection()
  }
}

function defaultPoisonHandler(info: { id: string; attempts: number; error: string }): void {
  console.error(
    `Audit outbox row ${info.id} failed ${info.attempts} times and remains failed: ${info.error}`
  )
}
