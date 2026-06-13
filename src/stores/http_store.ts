import { createHmac } from 'node:crypto'
import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import { chainBatch, GENESIS, verifyChain } from '../core/hash_chain.js'
import { canonicalJson } from '../core/canonical_json.js'
import { parseDuration } from '../core/retention.js'
import { AuditStoreError } from '../core/errors.js'

export interface HttpStoreOptions {
  url: string
  headers?: Record<string, string>
  signature?: {
    secretEnvVar: string
    header?: string
    algorithm?: 'sha256'
  }
  idempotencyHeader?: string
}

interface HeadState {
  seq: number
  hash: string
}

export default class HttpStore implements AuditStoreContract {
  readonly #url: string
  readonly #headers: Record<string, string>
  readonly #signature?: HttpStoreOptions['signature']
  readonly #idempotencyHeader: string
  readonly #heads: Map<string, HeadState>
  readonly #logs: Map<string, ChainedAuditEvent[]>

  constructor(options: HttpStoreOptions) {
    if (!options.url) {
      throw new AuditStoreError('HttpStore requires a URL')
    }

    this.#url = options.url
    this.#headers = options.headers ?? {}
    this.#signature = options.signature
    this.#idempotencyHeader = options.idempotencyHeader ?? 'X-Idempotency-Key'
    this.#heads = new Map()
    this.#logs = new Map()
  }

  async write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    if (batch.length === 0) return []

    const grouped = this.#groupByStream(batch)
    const allChained: ChainedAuditEvent[] = []
    const newHeads = new Map<string, HeadState>()

    for (const [stream, events] of grouped) {
      const head = await this.head(stream)
      const chained = chainBatch(events, head)
      newHeads.set(stream, {
        seq: chained[chained.length - 1]!.seq,
        hash: chained[chained.length - 1]!.hash,
      })
      allChained.push(...chained)
    }

    await this.#post(allChained)

    for (const event of allChained) {
      const existing = this.#logs.get(event.stream) ?? []
      existing.push(event)
      this.#logs.set(event.stream, existing)
    }

    for (const [stream, head] of newHeads) {
      this.#heads.set(stream, head)
    }

    return allChained
  }

  async head(stream: string): Promise<{ seq: number; hash: string } | null> {
    return this.#heads.get(stream) ?? null
  }

  async *verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    const rows = this.#logs.get(stream) ?? []
    const filtered = rows.filter((row) => {
      if (range?.fromSeq !== undefined && row.seq < range.fromSeq) return false
      if (range?.toSeq !== undefined && row.seq > range.toSeq) return false
      return true
    })

    let report: VerifyReport | undefined
    for await (const r of verifyChain(toAsyncIterable(filtered))) {
      report = r
      yield r
    }

    if (!report) {
      yield { stream, valid: true, checkedCount: 0 }
    }
  }

  async prune(policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    const now = Date.now()
    let totalPruned = 0
    const perEvent: Record<string, number> = {}
    const streams: string[] = []

    for (const [stream, rows] of this.#logs) {
      if (rows.length === 0) continue

      streams.push(stream)
      const headSeq = rows[rows.length - 1]!.seq
      const retained: ChainedAuditEvent[] = []
      const pruned: ChainedAuditEvent[] = []

      for (const row of rows) {
        const matchesFilter = policy.eventFilter === undefined || row.event === policy.eventFilter
        const duration = policy.perEvent?.[row.event] ?? policy.default
        const cutoff = new Date(now - parseDuration(duration)).toISOString()
        const isHead = row.seq === headSeq

        if (!matchesFilter || isHead || row.createdAt >= cutoff) {
          retained.push(row)
          continue
        }

        pruned.push(row)
        totalPruned++
        perEvent[row.event] = (perEvent[row.event] ?? 0) + 1
      }

      if (pruned.length > 0 && policy.archive && !policy.dryRun) {
        await policy.archive({
          event: policy.eventFilter ?? pruned[0]!.event,
          stream,
          fromSeq: pruned[0]!.seq,
          toSeq: pruned[pruned.length - 1]!.seq,
          count: pruned.length,
          fromCreatedAt: pruned[0]!.createdAt,
          toCreatedAt: pruned[pruned.length - 1]!.createdAt,
        })
      }

      if (!policy.dryRun) {
        this.#logs.set(stream, retained)
      }
    }

    return { streams, totalPruned, perEvent }
  }

  #groupByStream(batch: AuditEvent[]): Map<string, AuditEvent[]> {
    const grouped = new Map<string, AuditEvent[]>()
    for (const event of batch) {
      const existing = grouped.get(event.stream)
      if (existing) {
        existing.push(event)
      } else {
        grouped.set(event.stream, [event])
      }
    }
    return grouped
  }

  async #post(chained: ChainedAuditEvent[]): Promise<void> {
    const body = JSON.stringify(chained)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.#headers,
    }

    headers[this.#idempotencyHeader] = `${chained[0]!.id}:${chained[chained.length - 1]!.id}`

    if (this.#signature) {
      const secret = process.env[this.#signature.secretEnvVar]
      if (!secret) {
        throw new AuditStoreError(
          `HTTP store signature requires env var ${this.#signature.secretEnvVar}`
        )
      }

      const signature = this.#sign(canonicalJson(chained), secret)
      headers[this.#signature.header ?? 'X-Audit-Signature'] = signature
    }

    let response: Response
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        headers,
        body,
      })
    } catch (error) {
      throw new AuditStoreError(
        `HttpStore request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new AuditStoreError(
        `HttpStore collector returned ${response.status}: ${text.slice(0, 200)}`
      )
    }
  }

  #sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
  }
}

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

export { GENESIS }
