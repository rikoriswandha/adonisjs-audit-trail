import type { ApplicationService } from '@adonisjs/core/types'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import type { AuditEvent, AuditStoreContract } from '../types.js'

interface OutboxRow {
  id: string | number
  payload: unknown
  attempts?: number | string | null
}

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
    throw new Error('Invalid audit outbox payload')
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

  throw new Error('Invalid audit outbox payload')
}

export default class AuditOutboxDrainer {
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(
    protected app: ApplicationService,
    protected store: AuditStoreContract
  ) {}

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

    const rows = (await db
      .query()
      .from('audit_outbox')
      .whereNull('processed_at')
      .orderBy('id', 'asc')
      .limit(limit)) as OutboxRow[]

    let processed = 0

    for (const row of rows) {
      const now = new Date().toISOString()
      const attempts = Number(row.attempts ?? 0) + 1

      await db.query().from('audit_outbox').where('id', row.id).update({
        claimed_at: now,
        attempts,
        updated_at: now,
      })

      try {
        const events = normalizePayload(row.payload)
        if (events.length > 0) {
          await this.store.write(events)
        }

        const processedAt = new Date().toISOString()
        await db.query().from('audit_outbox').where('id', row.id).update({
          processed_at: processedAt,
          updated_at: processedAt,
        })
        processed++
      } catch {
        await db.query().from('audit_outbox').where('id', row.id).update({
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
      }
    }

    return processed
  }

  async #db(): Promise<QueryClientContract> {
    const db = await this.app.container.make('lucid.db')
    return db.connection()
  }
}
