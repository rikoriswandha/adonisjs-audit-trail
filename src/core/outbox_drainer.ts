import type { ApplicationService } from '@adonisjs/core/types'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { AuditEvent, AuditStoreContract } from '../types.js'
import { AuditOutboxPayloadError } from './errors.js'

const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 5

interface OutboxRow {
  id: string | number
  payload: unknown
  attempts?: number | string | null
}

type PoisonHandler = (info: { id: string | number; payload: unknown; attempts: number }) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload
  return JSON.parse(payload) as unknown
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return isRecord(value) && typeof value.id === 'string' && typeof value.event === 'string'
}

function normalizePayload(payload: unknown): AuditEvent[] {
  const value = parseJsonPayload(payload)

  if (Array.isArray(value)) {
    return value.filter(isAuditEvent)
  }
  if (!isRecord(value)) {
    throw new AuditOutboxPayloadError()
  }

  if (Array.isArray(value.events)) {
    return value.events.filter(isAuditEvent)
  }

  if (isAuditEvent(value.event)) {
    return [value.event]
  }

  if (isAuditEvent(value)) {
    return [value]
  }

  throw new AuditOutboxPayloadError()
}

export default class AuditOutboxDrainer {
  #timer: ReturnType<typeof setInterval> | null = null
  #staleClaimMs: number
  #maxAttempts: number
  #onPoison: PoisonHandler

  constructor(
    protected app: ApplicationService,
    protected store: AuditStoreContract,
    staleClaimMs: number = DEFAULT_STALE_CLAIM_MS,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    onPoison: PoisonHandler = defaultPoisonHandler
  ) {
    this.#staleClaimMs = staleClaimMs
    this.#maxAttempts = maxAttempts
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
    const db = await this.#db()
    if (!(await db.schema.hasTable('audit_outbox'))) {
      return 0
    }

    const now = new Date()
    const staleHorizon = new Date(now.getTime() - this.#staleClaimMs)

    const rows = (await db
      .query()
      .from('audit_outbox')
      .whereNull('processed_at')
      .andWhere((builder) => {
        void builder.whereNull('claimed_at').orWhere('claimed_at', '<', staleHorizon)
      })
      .orderBy('id', 'asc')
      .limit(limit)) as OutboxRow[]

    let processed = 0

    for (const row of rows) {
      const claimedAt = new Date()
      const claimed = await this.#claim(db, row, claimedAt)
      if (!claimed) {
        continue
      }

      try {
        const events = normalizePayload(row.payload)
        if (events.length > 0) {
          await this.store.write(events)
        }

        const processedAt = new Date()
        await db.query().from('audit_outbox').where('id', row.id).update({
          processed_at: processedAt,
          updated_at: processedAt,
        })
        processed++
      } catch {
        const attempts = Number(row.attempts ?? 0) + 1

        if (attempts >= this.#maxAttempts) {
          const failedAt = new Date()
          await db.query().from('audit_outbox').where('id', row.id).update({
            processed_at: failedAt,
            updated_at: failedAt,
          })
          this.#onPoison({ id: row.id, payload: row.payload, attempts })
          continue
        }

        await db.query().from('audit_outbox').where('id', row.id).update({
          claimed_at: null,
          updated_at: new Date(),
        })
      }
    }

    return processed
  }

  async #claim(db: QueryClientContract, row: OutboxRow, claimedAt: Date): Promise<boolean> {
    const staleHorizon = new Date(claimedAt.getTime() - this.#staleClaimMs)
    const attempts = Number(row.attempts ?? 0) + 1
    const affected = await db
      .query()
      .from('audit_outbox')
      .where('id', row.id)
      .whereNull('processed_at')
      .andWhere((builder) => {
        void builder.whereNull('claimed_at').orWhere('claimed_at', '<', staleHorizon)
      })
      .update({
        claimed_at: claimedAt,
        attempts,
        updated_at: claimedAt,
      })

    return Number(affected) > 0
  }

  async #db(): Promise<QueryClientContract> {
    const db = await this.app.container.make('lucid.db')
    return db.connection()
  }
}

function defaultPoisonHandler(info: { id: string | number; attempts: number }): void {
  console.error(
    `Audit outbox row ${info.id} failed ${info.attempts} times and was dead-lettered; ` +
      `payload is irrecoverable and the row has been marked processed.`
  )
}
