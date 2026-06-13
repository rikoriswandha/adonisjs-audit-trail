import type { AuditEvent, OverflowStrategy, PipelineStats } from '../types.js'
import type { AuditStoreContract } from '../types.js'
import { AuditCoupledTimeoutError } from './errors.js'

export interface PipelineConfig {
  maxBatchSize: number
  flushIntervalMs: number
  capacity: number
  overflow: OverflowStrategy
  retryBaseDelayMs?: number
}

export interface PipelineDependencies {
  store: AuditStoreContract
  redactor?: { redact: (data: Record<string, unknown>) => Record<string, unknown> }
  deadLetterHandler?: (events: AuditEvent[]) => void
}

export default class AuditPipeline {
  #config: PipelineConfig
  #store: AuditStoreContract
  #redactor?: { redact: (data: Record<string, unknown>) => Record<string, unknown> }
  #deadLetterHandler: (events: AuditEvent[]) => void

  #buffer: AuditEvent[]
  #head = 0
  #tail = 0
  #size = 0

  #flushing = false
  #flushTimer: ReturnType<typeof setInterval> | null = null
  #started = false

  #queued = 0
  #written = 0
  #dropped = 0
  #retried = 0
  #deadLettered = 0
  #lastFlushAt: Date | null = null

  #coupled = new Map<string, () => void>()

  constructor(config: PipelineConfig, deps: PipelineDependencies) {
    this.#config = config
    this.#store = deps.store
    this.#redactor = deps.redactor
    this.#deadLetterHandler = deps.deadLetterHandler ?? defaultDeadLetterHandler
    this.#buffer = new Array(config.capacity)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#flushTimer = setInterval(() => {
      this.#flush().catch(() => {})
    }, this.#config.flushIntervalMs)
    this.#flushTimer.unref()
  }

  enqueue(event: AuditEvent): boolean {
    if (this.#redactor) {
      event = this.#redactEvent(event)
    }

    if (this.#size >= this.#config.capacity) {
      const handled = this.#handleOverflow(event)
      if (!handled) return false
    }

    this.#buffer[this.#tail] = event
    this.#tail = (this.#tail + 1) % this.#config.capacity
    this.#size++
    this.#queued++

    if (this.#size >= this.#config.maxBatchSize) {
      this.#flush().catch(() => {})
    }

    return true
  }

  async requestCoupledFlush(eventIds: string[], timeoutMs = 5000): Promise<void> {
    const { promise: flushed, resolve, reject } = Promise.withResolvers<void>()
    let resolved = false

    const cleanup = () => {
      for (const id of eventIds) {
        this.#coupled.delete(id)
      }
    }

    const wrappedResolve = () => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve()
    }

    for (const id of eventIds) {
      this.#coupled.set(id, wrappedResolve)
    }

    this.#flush().catch(() => {})

    const timeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(new AuditCoupledTimeoutError())
    }, timeoutMs)

    try {
      await flushed
    } finally {
      clearTimeout(timeout)
    }
  }

  async shutdown(deadlineMs = 5000): Promise<void> {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer)
      this.#flushTimer = null
    }

    const deadline = Date.now() + deadlineMs
    while (this.#size > 0 && Date.now() < deadline) {
      await this.#flush()
    }

    if (this.#size > 0) {
      const pending = this.#drainBuffer()
      this.#deadLetterHandler(pending)
      this.#deadLettered += pending.length
    }
  }

  stats(): PipelineStats {
    return {
      queued: this.#queued,
      written: this.#written,
      dropped: this.#dropped,
      retried: this.#retried,
      deadLettered: this.#deadLettered,
      lastFlushAt: this.#lastFlushAt,
    }
  }

  #redactEvent(event: AuditEvent): AuditEvent {
    const redactor = this.#redactor!
    return {
      ...event,
      oldValues: event.oldValues ? redactor.redact(event.oldValues) : event.oldValues,
      newValues: event.newValues ? redactor.redact(event.newValues) : event.newValues,
      metadata: event.metadata ? redactor.redact(event.metadata) : event.metadata,
    }
  }

  #handleOverflow(event: AuditEvent): boolean {
    if (this.#config.overflow === 'dropNew') {
      this.#dropped++
      return false
    }

    if (this.#config.overflow === 'dropOldest') {
      this.#dropOldest()
      return true
    }

    if (this.#config.overflow === 'block') {
      return this.#blockUntilSpace(event)
    }

    return false
  }

  #dropOldest(): void {
    this.#buffer[this.#head] = undefined as unknown as AuditEvent
    this.#head = (this.#head + 1) % this.#config.capacity
    this.#size--
    this.#dropped++
  }

  #blockUntilSpace(event: AuditEvent): boolean {
    const deadline = Date.now() + 5000
    while (this.#size >= this.#config.capacity && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }

    if (this.#size >= this.#config.capacity) {
      this.#dropped++
      return false
    }

    return this.enqueue(event)
  }

  async #flush(): Promise<void> {
    if (this.#flushing || this.#size === 0) return
    this.#flushing = true

    const batch = this.#drainBuffer()
    const eventIds = batch.map((e) => e.id)

    let attempts = 0
    const maxAttempts = 5
    const baseDelay = this.#config.retryBaseDelayMs ?? 100

    while (attempts < maxAttempts) {
      try {
        await this.#store.write(batch, { getHead: (stream) => this.#store.head(stream) })
        this.#written += batch.length
        this.#lastFlushAt = new Date()
        this.#resolveCoupled(eventIds)
        this.#flushing = false
        return
      } catch (error) {
        attempts++
        this.#retried++

        if (attempts >= maxAttempts) {
          this.#deadLetterHandler(batch)
          this.#deadLettered += batch.length
          this.#flushing = false
          return
        }

        const delay = 2 ** attempts * baseDelay + Math.random() * 100
        await sleep(delay)
      }
    }
  }

  #drainBuffer(): AuditEvent[] {
    const batchSize = Math.min(this.#size, this.#config.maxBatchSize)
    const batch: AuditEvent[] = []

    for (let i = 0; i < batchSize; i++) {
      const event = this.#buffer[this.#head]
      this.#buffer[this.#head] = undefined as unknown as AuditEvent
      this.#head = (this.#head + 1) % this.#config.capacity
      this.#size--
      batch.push(event)
    }

    return batch
  }

  #resolveCoupled(eventIds: string[]): void {
    const resolved = new Set<() => void>()
    for (const id of eventIds) {
      const resolver = this.#coupled.get(id)
      if (resolver) {
        resolved.add(resolver)
        this.#coupled.delete(id)
      }
    }
    for (const resolver of resolved) {
      resolver()
    }
  }
}

function defaultDeadLetterHandler(events: AuditEvent[]): void {
  const line = events.map((e) => JSON.stringify(e)).join('\n')
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const dlqPath = path.join(process.cwd(), 'storage', 'audit-dlq')
    fs.mkdirSync(path.dirname(dlqPath), { recursive: true })
    fs.appendFileSync(dlqPath, line + '\n')
  } catch {
    // Last resort: silently drop if filesystem is unavailable
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
