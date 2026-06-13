import { createHmac } from 'node:crypto'
import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import { chainBatch, GENESIS } from '../core/hash_chain.js'
import { canonicalJson } from '../core/canonical_json.js'
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

  constructor(options: HttpStoreOptions) {
    if (!options.url) {
      throw new AuditStoreError('HttpStore requires a URL')
    }

    this.#url = options.url
    this.#headers = options.headers ?? {}
    this.#signature = options.signature
    this.#idempotencyHeader = options.idempotencyHeader ?? 'X-Idempotency-Key'
    this.#heads = new Map()
  }

  async write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    if (batch.length === 0) return []

    const grouped = this.#groupByStream(batch)
    const allChained: ChainedAuditEvent[] = []

    for (const [stream, events] of grouped) {
      const head = await this.head(stream)
      const chained = chainBatch(events, head)
      this.#heads.set(stream, {
        seq: chained[chained.length - 1]!.seq,
        hash: chained[chained.length - 1]!.hash,
      })
      allChained.push(...chained)
    }

    await this.#post(allChained)
    return allChained
  }

  async head(stream: string): Promise<{ seq: number; hash: string } | null> {
    return this.#heads.get(stream) ?? null
  }

  async *verify(
    _stream: string,
    _range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    yield { stream: _stream, valid: true, checkedCount: 0 }
  }

  async prune(_policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    return { streams: [], totalPruned: 0, perEvent: {} }
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

    const json = await response.json().catch(() => null)
    if (this.#isHeadResponse(json)) {
      this.#heads.set(json.stream, { seq: json.seq, hash: json.hash })
    }
  }

  #sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  #isHeadResponse(value: unknown): value is HeadState & { stream: string } {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>).stream === 'string' &&
      typeof (value as Record<string, unknown>).seq === 'number' &&
      typeof (value as Record<string, unknown>).hash === 'string'
    )
  }
}

export { GENESIS }
