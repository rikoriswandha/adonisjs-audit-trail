import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import { chainBatch, GENESIS, hashEntry, verifyChain } from '../core/hash_chain.js'
import { canonicalJson } from '../core/canonical_json.js'
import { AuditStoreError } from '../core/errors.js'

export interface StreamStoreOptions {
  destination?: 'stdout' | 'stderr' | string | Writable
  format?: 'ndjson' | 'json'
}

interface HeadState {
  seq: number
  hash: string
}

type Destination =
  | { type: 'stdout' | 'stderr' }
  | { type: 'file'; path: string }
  | { type: 'writable'; stream: Writable }

function resolveDestination(destination: StreamStoreOptions['destination']): Destination {
  if (destination === undefined || destination === 'stdout') {
    return { type: 'stdout' }
  }

  if (destination === 'stderr') {
    return { type: 'stderr' }
  }

  if (typeof destination === 'string') {
    return { type: 'file', path: isAbsolute(destination) ? destination : resolve(destination) }
  }

  return { type: 'writable', stream: destination }
}

function sidecarPath(filePath: string): string {
  return `${filePath}.head.json`
}

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

export default class StreamStore implements AuditStoreContract {
  readonly #destination: Destination
  readonly #format: 'ndjson' | 'json'
  readonly #heads: Map<string, HeadState>
  readonly #sidecarPath?: string

  constructor(options: StreamStoreOptions = {}) {
    this.#destination = resolveDestination(options.destination)
    this.#format = options.format ?? 'ndjson'
    this.#heads = new Map()

    if (this.#destination.type === 'file') {
      this.#sidecarPath = sidecarPath(this.#destination.path)
      this.#loadHeads()
    }
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

    await this.#writeEvents(allChained)
    this.#persistHeads()

    return allChained
  }

  async head(stream: string): Promise<{ seq: number; hash: string } | null> {
    const head = this.#heads.get(stream)
    return head ?? null
  }

  async *verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    if (this.#destination.type !== 'file') {
      yield { stream, valid: true, checkedCount: 0 }
      return
    }

    const rows = this.#readFileEvents(stream, range)
    let report: VerifyReport | undefined

    for await (const r of verifyChain(toAsyncIterable(rows))) {
      report = r
      yield r
    }

    if (!report) {
      yield { stream, valid: true, checkedCount: 0 }
    }
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

  async #writeEvents(chained: ChainedAuditEvent[]): Promise<void> {
    if (this.#format === 'json') {
      await this.#writeLine(canonicalJson(chained))
      return
    }

    for (const event of chained) {
      await this.#writeLine(canonicalJson(event))
    }
  }

  async #writeLine(line: string): Promise<void> {
    const payload = `${line}\n`

    if (this.#destination.type === 'stdout') {
      const ok = process.stdout.write(payload)
      if (!ok) {
        await new Promise<void>((res) => process.stdout.once('drain', res))
      }
      return
    }

    if (this.#destination.type === 'stderr') {
      const ok = process.stderr.write(payload)
      if (!ok) {
        await new Promise<void>((res) => process.stderr.once('drain', res))
      }
      return
    }

    if (this.#destination.type === 'file') {
      const dir = dirname(this.#destination.path)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const stream = createWriteStream(this.#destination.path, { flags: 'a' })
      await new Promise<void>((res, rej) => {
        stream.write(payload, (error) => {
          if (error) {
            rej(new AuditStoreError(`Stream store write failed: ${error.message}`))
          } else {
            res()
          }
        })
      })
      stream.end()
      return
    }

    if (this.#destination.type === 'writable') {
      const writable = this.#destination.stream
      const ok = writable.write(payload)
      if (!ok) {
        await new Promise<void>((res) => writable.once('drain', res))
      }
    }
  }

  #readFileEvents(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number }
  ): ChainedAuditEvent[] {
    if (this.#destination.type !== 'file') {
      return []
    }

    if (!existsSync(this.#destination.path)) {
      return []
    }

    const content = readFileSync(this.#destination.path, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim().length > 0)

    const events: ChainedAuditEvent[] = []

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ChainedAuditEvent | ChainedAuditEvent[]
        const batch = Array.isArray(parsed) ? parsed : [parsed]
        for (const event of batch) {
          if (event.stream !== stream) continue
          if (range?.fromSeq !== undefined && event.seq < range.fromSeq) continue
          if (range?.toSeq !== undefined && event.seq > range.toSeq) continue
          events.push(event)
        }
      } catch {
        // Skip malformed lines
      }
    }

    events.sort((a, b) => a.seq - b.seq)
    return events
  }

  #loadHeads(): void {
    if (!this.#sidecarPath || !existsSync(this.#sidecarPath)) {
      return
    }

    try {
      const data = JSON.parse(readFileSync(this.#sidecarPath, 'utf-8')) as Record<string, HeadState>
      for (const [stream, head] of Object.entries(data)) {
        this.#heads.set(stream, head)
      }
    } catch {
      // Ignore corrupted sidecar
    }
  }

  #persistHeads(): void {
    if (!this.#sidecarPath) {
      return
    }

    const dir = dirname(this.#sidecarPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const data: Record<string, HeadState> = {}
    for (const [stream, head] of this.#heads) {
      data[stream] = head
    }

    writeFileSync(this.#sidecarPath, JSON.stringify(data))
  }
}

export { GENESIS, hashEntry }
