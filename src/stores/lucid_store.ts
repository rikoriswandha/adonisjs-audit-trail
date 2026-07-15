import type { ApplicationService } from '@adonisjs/core/types'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type {
  AuditEvent,
  AuditReadOptions,
  AuditQueryFilters,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import type { LucidStoreOptions } from '../define_config.js'
import { chainBatch, GENESIS, hashEntry } from '../core/hash_chain.js'
import { parseDuration } from '../core/retention.js'
import { canonicalJson } from '../core/canonical_json.js'
import { AuditOutboxIntegrityError, AuditStoreError } from '../core/errors.js'

interface Row {
  id: string
  seq: number | string
  stream: string
  event: string
  auditable_type: string | null
  auditable_id: string | null
  old_values: unknown
  new_values: unknown
  metadata: unknown
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
  tags: unknown
  schema_version: string
  hash: string
  prev_hash: string
  created_at: unknown
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>
  return value as Record<string, unknown>
}

function parseTags(value: unknown): string[] {
  if (value === null) return []
  if (typeof value === 'string') return JSON.parse(value) as string[]
  return value as string[]
}

function isSqlite(dialect: string): boolean {
  return dialect === 'sqlite' || dialect === 'sqlite3' || dialect === 'better-sqlite3'
}

function toDbTimestamp(value: string, dialect: string): string | Date {
  return isSqlite(dialect) ? value : new Date(value)
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString()
  }
  return String(value)
}

function rowToChainedEvent(row: Row): ChainedAuditEvent {
  return {
    id: row.id,
    seq: Number(row.seq),
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
    createdAt: toIsoString(row.created_at),
    hash: row.hash,
    prevHash: row.prev_hash,
  }
}

function auditEventFingerprint(event: AuditEvent): string {
  const {
    id,
    event: name,
    stream,
    auditableType,
    auditableId,
    oldValues,
    newValues,
    metadata,
  } = event
  const createdAt = new Date(event.createdAt)
  return canonicalJson({
    id,
    event: name,
    stream,
    auditableType,
    auditableId,
    oldValues,
    newValues,
    metadata,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      label: event.actor.label ?? null,
    },
    tenantId: event.tenantId,
    requestId: event.requestId,
    correlationId: event.correlationId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    url: event.url,
    httpMethod: event.httpMethod,
    tags: event.tags,
    schemaVersion: event.schemaVersion,
    createdAt: Number.isNaN(createdAt.getTime()) ? event.createdAt : createdAt.toISOString(),
  })
}

export default class LucidStore implements AuditStoreContract {
  #app: ApplicationService
  #connection?: string
  #table: string
  #maintenance?: (trx: TransactionClientContract) => Promise<void>

  constructor(app: ApplicationService, opts: LucidStoreOptions = {}) {
    this.#app = app
    this.#connection = opts.connection
    this.#table = opts.table ?? 'audits'
    this.#maintenance = opts.maintenance
  }

  withConnection(connection: string): AuditStoreContract {
    return new LucidStore(this.#app, {
      connection,
      table: this.#table,
      maintenance: this.#maintenance,
    })
  }

  async write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    if (batch.length === 0) return []

    const db = await this.#db()
    const ids = Array.from(new Set(batch.map((event) => event.id)))
    const existingRows = (await db.query().from(this.#table).whereIn('id', ids)) as Row[]
    const existing = new Map(existingRows.map((row) => [row.id, rowToChainedEvent(row)]))
    const incoming = new Map<string, AuditEvent>()
    const byStream = new Map<string, AuditEvent[]>()
    const results = new Map<string, ChainedAuditEvent>()

    for (const event of batch) {
      const duplicate = incoming.get(event.id)
      if (duplicate && auditEventFingerprint(duplicate) !== auditEventFingerprint(event)) {
        throw new AuditOutboxIntegrityError(
          `Audit event ${event.id} has conflicting duplicate payloads`
        )
      }
      incoming.set(event.id, event)

      const stored = existing.get(event.id)
      if (stored) {
        if (auditEventFingerprint(stored) !== auditEventFingerprint(event)) {
          throw new AuditOutboxIntegrityError(
            `Audit event ${event.id} conflicts with the target store`
          )
        }
        results.set(event.id, stored)
        continue
      }

      if (duplicate) continue
      const events = byStream.get(event.stream) ?? []
      events.push(event)
      byStream.set(event.stream, events)
    }

    for (const [stream, events] of byStream) {
      const chained = await this.#writeStream(stream, events)
      for (const event of chained) {
        results.set(event.id, event)
      }
    }

    return batch.map((event) => {
      const result = results.get(event.id)
      if (!result) {
        throw new AuditOutboxIntegrityError(`Audit event ${event.id} was not persisted`)
      }
      return result
    })
  }

  async head(
    stream: string,
    options?: AuditReadOptions
  ): Promise<{ seq: number; hash: string } | null> {
    const db = await this.#db(options)
    const rows = (await db
      .query()
      .from(this.#table)
      .where('stream', stream)
      .orderBy('seq', 'desc')
      .limit(1)) as Row[]
    const row = rows[0]
    return row ? { seq: Number(row.seq), hash: row.hash } : null
  }
  async listStreams(options?: AuditReadOptions): Promise<string[]> {
    const db = await this.#db(options)
    const rows = (await db
      .query()
      .select('stream')
      .from(this.#table)
      .groupBy('stream')
      .orderBy('stream', 'asc')) as { stream: string }[]
    return rows.map((row) => row.stream)
  }

  async *verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number },
    options?: AuditReadOptions
  ): AsyncGenerator<VerifyReport> {
    const db = await this.#db(options)
    const pageSize = 500
    const fromSeq = range?.fromSeq ?? 1
    let prevSeq = 0
    let prevHash = GENESIS
    let checked = 0
    let firstInvalidSeq: number | undefined

    const precedingRows = (await db
      .query()
      .select('seq', 'hash')
      .from(this.#table)
      .where('stream', stream)
      .andWhere('seq', '<', fromSeq)
      .orderBy('seq', 'desc')
      .limit(1)) as Row[]

    const preceding = precedingRows[0]
    if (preceding) {
      prevSeq = Number(preceding.seq)
      prevHash = preceding.hash
    } else {
      const firstLiveRows = (await db
        .query()
        .select('seq')
        .from(this.#table)
        .where('stream', stream)
        .orderBy('seq', 'asc')
        .limit(1)) as Row[]
      const firstLive = firstLiveRows[0]

      if (firstLive) {
        const checkpointRows = (await db
          .query()
          .select('seq', 'hash')
          .from('audit_chain_checkpoints')
          .where('stream', stream)
          .andWhere('seq', '<', Number(firstLive.seq))
          .orderBy('seq', 'desc')
          .limit(1)) as Row[]
        const checkpoint = checkpointRows[0]
        if (checkpoint) {
          prevSeq = Number(checkpoint.seq)
          prevHash = checkpoint.hash
        }
      }
    }

    let lastSeq = prevSeq
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

  async resolveSequenceHash(
    stream: string,
    seq: number,
    options?: AuditReadOptions
  ): Promise<string | null> {
    const db = await this.#db(options)
    for (const table of [this.#table, 'audit_archive_events', 'audit_chain_checkpoints']) {
      const rows = (await db
        .query()
        .select('hash')
        .from(table)
        .where('stream', stream)
        .andWhere('seq', seq)
        .limit(1)) as { hash: string }[]
      if (rows[0]) return rows[0].hash
    }
    return null
  }

  async prune(policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    const db = await this.#db()
    const dialect = db.dialect.name
    const now = Date.now()
    let totalPruned = 0
    const perEvent: Record<string, number> = {}
    const streams = new Set<string>()

    const streamRows = (await db.query().select('stream').from(this.#table).groupBy('stream')) as {
      stream: string
    }[]

    for (const { stream } of streamRows) {
      const rows = (await db
        .query()
        .from(this.#table)
        .where('stream', stream)
        .orderBy('seq', 'asc')) as Row[]

      if (rows.length < 2) continue
      const first = rows[0]
      if (!first || (policy.eventFilter !== undefined && first.event !== policy.eventFilter))
        continue

      const candidates: Row[] = []
      for (const row of rows.slice(0, -1)) {
        if (
          row.event !== first.event ||
          (policy.eventFilter !== undefined && row.event !== policy.eventFilter)
        ) {
          break
        }

        const duration = policy.perEvent?.[row.event] ?? policy.default
        const cutoff = new Date(now - parseDuration(duration)).toISOString()
        if (toIsoString(row.created_at) >= cutoff) break
        candidates.push(row)
      }

      if (candidates.length === 0) continue
      streams.add(stream)
      const count = candidates.length
      const event = first.event

      if (policy.dryRun) {
        totalPruned += count
        perEvent[event] = (perEvent[event] ?? 0) + count
        continue
      }

      if (!this.#maintenance) {
        throw new Error(
          'Physical audit pruning requires a LucidStore maintenance operation configured for this store'
        )
      }

      const from = candidates[0]!
      const to = candidates[candidates.length - 1]!
      const segment = {
        idempotencyKey: `${stream}:${Number(from.seq)}:${Number(to.seq)}`,
        fromSeq: Number(from.seq),
        toSeq: Number(to.seq),
        count,
        fromCreatedAt: toIsoString(from.created_at),
        toCreatedAt: toIsoString(to.created_at),
        event,
        stream,
      }
      const ids = candidates.map((row) => row.id)
      const candidateById = new Map(candidates.map((row) => [row.id, row]))
      const archivedRows = (await db
        .query()
        .select('id', 'stream', 'seq', 'hash', 'prev_hash')
        .from('audit_archive_events')
        .whereIn('id', ids)) as Pick<Row, 'id' | 'stream' | 'seq' | 'hash' | 'prev_hash'>[]
      const archivedIds = new Set(archivedRows.map((row) => row.id))

      for (const archived of archivedRows) {
        const source = candidateById.get(archived.id)
        if (
          !source ||
          source.stream !== archived.stream ||
          Number(source.seq) !== Number(archived.seq) ||
          source.hash !== archived.hash ||
          source.prev_hash !== archived.prev_hash
        ) {
          throw new Error(`Archived audit event ${archived.id} conflicts with the live audit event`)
        }
      }

      if (archivedIds.size !== ids.length) {
        if (policy.archive) await policy.archive(segment)

        const missing = candidates
          .filter((row) => !archivedIds.has(row.id))
          .map((row) => ({
            id: row.id,
            stream: row.stream,
            seq: Number(row.seq),
            hash: row.hash,
            prev_hash: row.prev_hash,
            created_at: row.created_at,
          }))
        await db.insertQuery().table('audit_archive_events').multiInsert(missing)
      }

      await db.transaction(async (trx) => {
        await this.#acquireLock(trx, stream, dialect)
        try {
          await this.#maintenance!(trx)
          await trx.query().from(this.#table).whereIn('id', ids).delete()
          await trx
            .insertQuery()
            .table('audit_chain_checkpoints')
            .insert({
              stream,
              seq: Number(to.seq),
              hash: to.hash,
              created_at: to.created_at,
            })
          if (isSqlite(dialect)) {
            await trx.query().from('audit_maintenance_guard').where('operation', 'prune').delete()
          }
        } finally {
          await this.#releaseLock(trx, stream, dialect)
        }
      })

      totalPruned += count
      perEvent[event] = (perEvent[event] ?? 0) + count
    }

    return {
      streams: Array.from(streams),
      totalPruned,
      perEvent,
    }
  }

  async query(
    filters: AuditQueryFilters,
    options?: AuditReadOptions
  ): Promise<ChainedAuditEvent[]> {
    const db = await this.#db(options)
    const dialect = db.dialect.name
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
      query = query.where('created_at', '>=', toDbTimestamp(filters.fromCreatedAt, dialect))
    }
    if (filters.toCreatedAt) {
      query = query.where('created_at', '<=', toDbTimestamp(filters.toCreatedAt, dialect))
    }

    const limit = filters.limit ?? 100
    if (filters.cursor !== undefined) {
      query = query.where('seq', '>', filters.cursor)
    }

    const rows = (await query.orderBy('seq', 'asc').limit(limit)) as Row[]
    return rows.map(rowToChainedEvent)
  }

  async #db(options?: AuditReadOptions): Promise<QueryClientContract> {
    if (options?.client) return options.client
    const db = await this.#app.container.make('lucid.db')
    const connection = options?.connection ?? this.#connection
    return connection ? db.connection(connection) : db.connection()
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

        const head = headRows[0] ? { seq: Number(headRows[0].seq), hash: headRows[0].hash } : null
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
          created_at: toDbTimestamp(event.createdAt, dialect),
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
      const response = await db.rawQuery('SELECT GET_LOCK(?, 5) AS lock_status', [stream])
      if (response[0]?.[0]?.lock_status !== 1) {
        throw new AuditStoreError(
          `Could not acquire MySQL advisory lock for audit stream "${stream}"`
        )
      }
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
