import type { ApplicationService } from '@adonisjs/core/types'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type {
  AuditEvent,
  AuditQueryFilters,
  AuditStoreContract,
  ChainContext,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import type { LucidStoreOptions } from '../define_config.js'
import { chainBatch, GENESIS, hashEntry } from '../core/hash_chain.js'
import { AuditStoreError } from '../core/errors.js'

interface Row {
  id: string
  seq: number
  stream: string
  event: string
  auditable_type: string | null
  auditable_id: string | null
  old_values: string | null
  new_values: string | null
  metadata: string | null
  actor_type: string
  actor_id: string | null
  actor_label: string | null
  tenant_id: string | null
  request_id: string | null
  correlation_id: string | null
  ip_address: string | null
  user_agent: string | null
  url: string | null
  http_method: string | null
  tags: string | null
  schema_version: string
  hash: string
  prev_hash: string
  created_at: string
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/i)
  if (!match) {
    throw new AuditStoreError(`Invalid retention duration: ${duration}`)
  }

  const value = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()

  const msPerDay = 24 * 60 * 60 * 1000
  switch (unit) {
    case 'day':
    case 'days':
      return value * msPerDay
    case 'week':
    case 'weeks':
      return value * 7 * msPerDay
    case 'month':
    case 'months':
      return value * 30 * msPerDay
    case 'year':
    case 'years':
      return value * 365 * msPerDay
    default:
      throw new AuditStoreError(`Invalid retention duration: ${duration}`)
  }
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (value === null) return null
  return JSON.parse(value) as Record<string, unknown>
}

function parseTags(value: string | null): string[] {
  if (value === null) return []
  return JSON.parse(value) as string[]
}

function rowToChainedEvent(row: Row): ChainedAuditEvent {
  return {
    id: row.id,
    seq: row.seq,
    stream: row.stream,
    event: row.event,
    auditableType: row.auditable_type,
    auditableId: row.auditable_id,
    oldValues: parseJson(row.old_values),
    newValues: parseJson(row.new_values),
    metadata: parseJson(row.metadata),
    actor: {
      type: row.actor_type as 'user' | 'system' | 'job' | 'cli' | string,
      id: row.actor_id,
      label: row.actor_label,
    },
    tenantId: row.tenant_id,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    url: row.url,
    httpMethod: row.http_method,
    tags: parseTags(row.tags),
    schemaVersion: row.schema_version as '1',
    createdAt: row.created_at,
    hash: row.hash,
    prevHash: row.prev_hash,
  }
}

export default class LucidStore implements AuditStoreContract {
  #app: ApplicationService
  #connection?: string
  #table: string

  constructor(app: ApplicationService, opts: LucidStoreOptions = {}) {
    this.#app = app
    this.#connection = opts.connection
    this.#table = opts.table ?? 'audits'
  }

  async write(batch: AuditEvent[], _chainCtx: ChainContext): Promise<ChainedAuditEvent[]> {
    const byStream = new Map<string, AuditEvent[]>()

    for (const event of batch) {
      const events = byStream.get(event.stream) ?? []
      events.push(event)
      byStream.set(event.stream, events)
    }

    const results: ChainedAuditEvent[] = []

    for (const [stream, events] of byStream) {
      const chained = await this.#writeStream(stream, events)
      results.push(...chained)
    }

    return results
  }

  async head(stream: string): Promise<{ seq: number; hash: string } | null> {
    const db = await this.#db()
    const query = db
      .query()
      .from(this.#table)
      .where('stream', stream)
      .orderBy('seq', 'desc')
      .limit(1)
    const rows = (await query) as Row[]
    const row = rows[0]
    return row ? { seq: row.seq, hash: row.hash } : null
  }

  async *verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    const db = await this.#db()
    const pageSize = 500
    const fromSeq = range?.fromSeq ?? 1
    let lastSeq = fromSeq - 1
    let prevSeq = 0
    let prevHash = GENESIS
    let checked = 0
    let firstInvalidSeq: number | undefined

    if (fromSeq > 1) {
      const headRows = (await db
        .query()
        .select('seq', 'hash')
        .from(this.#table)
        .where('stream', stream)
        .andWhere('seq', '<', fromSeq)
        .orderBy('seq', 'desc')
        .limit(1)) as Row[]

      const head = headRows[0]
      if (head) {
        prevSeq = head.seq
        prevHash = head.hash
      }
    }

    while (true) {
      let query = db
        .query()
        .from(this.#table)
        .where('stream', stream)
        .andWhere('seq', '>', lastSeq)
        .orderBy('seq', 'asc')
        .limit(pageSize)

      if (range?.toSeq !== undefined) {
        query = query.andWhere('seq', '<=', range.toSeq)
      }

      const rows = (await query) as Row[]
      if (rows.length === 0) return

      for (const row of rows) {
        const event = rowToChainedEvent(row)
        checked++
        lastSeq = event.seq

        const expectedSeq = prevSeq + 1
        const expectedHash = hashEntry({ ...event, seq: expectedSeq, prevHash })
        const valid = event.seq === expectedSeq && event.hash === expectedHash

        if (valid) {
          prevSeq = event.seq
          prevHash = event.hash
          yield {
            stream,
            valid: true,
            checkedCount: checked,
          }
          continue
        }

        firstInvalidSeq ??= event.seq
        yield {
          stream,
          valid: false,
          firstInvalidSeq,
          expectedHash,
          actualHash: event.hash,
          checkedCount: checked,
        }
      }

      if (rows.length < pageSize) return
    }
  }

  async prune(policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    const db = await this.#db()
    const now = Date.now()
    let totalPruned = 0
    const perEvent: Record<string, number> = {}
    const streams = new Set<string>()

    const streamRows = (await db.query().select('stream').from(this.#table).groupBy('stream')) as {
      stream: string
    }[]

    for (const { stream } of streamRows) {
      streams.add(stream)

      const eventTypes = (await db
        .query()
        .select('event')
        .from(this.#table)
        .where('stream', stream)
        .groupBy('event')) as { event: string }[]

      for (const { event } of eventTypes) {
        const duration = policy.perEvent?.[event] ?? policy.default
        const cutoff = new Date(now - parseDuration(duration)).toISOString()

        const headRows = (await db
          .query()
          .select('seq')
          .from(this.#table)
          .where('stream', stream)
          .orderBy('seq', 'desc')
          .limit(1)) as { seq: number }[]

        const headSeq = headRows[0]?.seq

        let query = db
          .query()
          .from(this.#table)
          .where('stream', stream)
          .andWhere('event', event)
          .andWhere('created_at', '<', cutoff)

        if (headSeq !== undefined) {
          query = query.andWhere('seq', '<', headSeq)
        }

        const result = Number((await query.del()) as unknown)
        totalPruned += result
        perEvent[event] = (perEvent[event] ?? 0) + result
      }
    }

    return {
      streams: Array.from(streams),
      totalPruned,
      perEvent,
    }
  }

  async query(filters: AuditQueryFilters): Promise<ChainedAuditEvent[]> {
    const db = await this.#db()
    let query = db.query().from(this.#table)

    if (filters.stream) {
      query = query.where('stream', filters.stream)
    }
    if (filters.event) {
      const events = Array.isArray(filters.event) ? filters.event : [filters.event]
      query = query.whereIn('event', events)
    }
    if (filters.auditableType) {
      query = query.where('auditable_type', filters.auditableType)
    }
    if (filters.auditableId) {
      query = query.where('auditable_id', filters.auditableId)
    }
    if (filters.actorType) {
      query = query.where('actor_type', filters.actorType)
    }
    if (filters.actorId) {
      query = query.where('actor_id', filters.actorId)
    }
    if (filters.tenantId) {
      query = query.where('tenant_id', filters.tenantId)
    }
    if (filters.fromSeq !== undefined) {
      query = query.where('seq', '>=', filters.fromSeq)
    }
    if (filters.toSeq !== undefined) {
      query = query.where('seq', '<=', filters.toSeq)
    }
    if (filters.fromCreatedAt) {
      query = query.where('created_at', '>=', filters.fromCreatedAt)
    }
    if (filters.toCreatedAt) {
      query = query.where('created_at', '<=', filters.toCreatedAt)
    }

    const limit = filters.limit ?? 100
    const offset = filters.cursor ?? 0

    const rows = (await query.orderBy('seq', 'asc').limit(limit).offset(offset)) as Row[]
    return rows.map(rowToChainedEvent)
  }

  async #db(): Promise<QueryClientContract> {
    const db = await this.#app.container.make('lucid.db')
    return this.#connection ? db.connection(this.#connection) : db.connection()
  }

  async #writeStream(stream: string, events: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    const db = await this.#db()
    const dialect = db.dialect.name

    return db.transaction(async (trx) => {
      await this.#acquireLock(trx, stream, dialect)

      try {
        const headRows = (await trx
          .query()
          .select('seq', 'hash')
          .from(this.#table)
          .where('stream', stream)
          .orderBy('seq', 'desc')
          .limit(1)) as Row[]

        const head = headRows[0] ? { seq: headRows[0].seq, hash: headRows[0].hash } : null
        const chained = chainBatch(events, head)

        const rows = chained.map((event) => ({
          id: event.id,
          stream: event.stream,
          seq: event.seq,
          hash: event.hash,
          prev_hash: event.prevHash,
          event: event.event,
          auditable_type: event.auditableType,
          auditable_id: event.auditableId,
          old_values: event.oldValues === null ? null : JSON.stringify(event.oldValues),
          new_values: event.newValues === null ? null : JSON.stringify(event.newValues),
          metadata: event.metadata === null ? null : JSON.stringify(event.metadata),
          actor_type: event.actor.type,
          actor_id: event.actor.id,
          actor_label: event.actor.label ?? null,
          tenant_id: event.tenantId,
          request_id: event.requestId,
          correlation_id: event.correlationId,
          ip_address: event.ipAddress,
          user_agent: event.userAgent,
          url: event.url,
          http_method: event.httpMethod,
          tags: JSON.stringify(event.tags),
          schema_version: event.schemaVersion,
          created_at: event.createdAt,
        }))

        await trx
          .insertQuery()
          .table(this.#table)
          .multiInsert(rows as Record<string, unknown>[])

        return chained
      } finally {
        await this.#releaseLock(trx, stream, dialect)
      }
    })
  }

  async #acquireLock(
    db: QueryClientContract | TransactionClientContract,
    stream: string,
    dialect: string
  ): Promise<void> {
    if (dialect === 'postgres') {
      await db.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [stream])
      return
    }

    if (dialect === 'mysql2' || dialect === 'mysql') {
      await db.rawQuery('SELECT GET_LOCK(?, 5)', [stream])
      return
    }

    // SQLite: single writer, no advisory lock needed
  }

  async #releaseLock(
    db: QueryClientContract | TransactionClientContract,
    stream: string,
    dialect: string
  ): Promise<void> {
    if (dialect === 'mysql2' || dialect === 'mysql') {
      await db.rawQuery('SELECT RELEASE_LOCK(?)', [stream])
    }
  }
}
