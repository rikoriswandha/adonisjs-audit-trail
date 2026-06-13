import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  AuditEvent,
  AuditRuntimeEvents,
  AuditStoreContract,
  OverflowStrategy,
  PipelineStats,
} from '../types.js'
import { AuditCoupledTimeoutError } from './errors.js'

export interface PipelineConfig {
  maxBatchSize: number
  flushIntervalMs: number
  capacity: number
  overflow: OverflowStrategy
  retryBaseDelayMs?: number
}

export interface PipelineStoreRoute {
  name: string
  store: AuditStoreContract
}

export interface PipelineEmitter {
  emit<Name extends keyof AuditRuntimeEvents>(
    event: Name,
    payload: AuditRuntimeEvents[Name]
  ): Promise<void>
}

export interface PipelineDependencies {
  store: AuditStoreContract
  storeName?: string
  routeStore?: (event: AuditEvent) => PipelineStoreRoute
  redactor?: { redact: (data: Record<string, unknown>) => Record<string, unknown> }
  deadLetterHandler?: (events: AuditEvent[]) => void
  emitter?: PipelineEmitter
}

export default class AuditPipeline {
  #config: PipelineConfig
  #store: AuditStoreContract
  #storeName: string
  #routeStore: (event: AuditEvent) => PipelineStoreRoute
  #redactor?: { redact: (data: Record<string, unknown>) => Record<string, unknown> }
  #deadLetterHandler: (events: AuditEvent[]) => void
  #emitter?: PipelineEmitter
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
    this.#storeName = deps.storeName ?? 'default'
    this.#routeStore = deps.routeStore ?? (() => ({ name: this.#storeName, store: this.#store }))
    this.#redactor = deps.redactor
    this.#deadLetterHandler = deps.deadLetterHandler ?? defaultDeadLetterHandler
    this.#emitter = deps.emitter
    this.#buffer = new Array(config.capacity)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#flushTimer = setInterval(() => {
      void this.#flush()
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
      void this.#flush()
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

    void this.#flush()

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
      this.#emit('audit:dead_letter', { events: pending, count: pending.length, error: null })
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
      this.#emit('audit:dropped', { strategy: 'dropNew', count: 1, event })
      return false
    }

    if (this.#config.overflow === 'dropOldest') {
      const dropped = this.#dropOldest()
      this.#emit('audit:dropped', { strategy: 'dropOldest', count: 1, event: dropped })
      return true
    }

    if (this.#config.overflow === 'block') {
      void this.#flush()
      if (this.#size < this.#config.capacity) return true
      this.#dropped++
      this.#emit('audit:dropped', { strategy: 'block', count: 1, event })
      return false
    }

    return false
  }

  #dropOldest(): AuditEvent {
    const dropped = this.#buffer[this.#head]
    this.#buffer[this.#head] = undefined as unknown as AuditEvent
    this.#head = (this.#head + 1) % this.#config.capacity
    this.#size--
    this.#dropped++
    return dropped
  }

  static createFileDeadLetterHandler(dlqPath: string): (events: AuditEvent[]) => void {
    return (events) => appendDeadLetters(dlqPath, events)
  }

  async #flush(): Promise<void> {
    if (this.#flushing || this.#size === 0) return
    this.#flushing = true

    const batch = this.#drainBuffer()
    const groups = this.#groupByStore(batch)

    try {
      for (const group of groups.values()) {
        await this.#writeWithRetry(group.name, group.store, group.events)
      }
    } finally {
      this.#flushing = false
    }
  }

  #groupByStore(batch: AuditEvent[]): Map<string, PipelineStoreRoute & { events: AuditEvent[] }> {
    const groups = new Map<string, PipelineStoreRoute & { events: AuditEvent[] }>()

    for (const event of batch) {
      const route = this.#routeStore(event)
      const existing = groups.get(route.name)
      if (existing) {
        existing.events.push(event)
        continue
      }

      groups.set(route.name, { ...route, events: [event] })
    }

    return groups
  }

  async #writeWithRetry(
    storeName: string,
    store: AuditStoreContract,
    batch: AuditEvent[]
  ): Promise<void> {
    const eventIds = batch.map((event) => event.id)
    let attempts = 0
    const maxAttempts = 5
    const baseDelay = this.#config.retryBaseDelayMs ?? 100
    let lastError: unknown = null

    while (attempts < maxAttempts) {
      try {
        const chained = await store.write(batch)
        this.#written += batch.length
        this.#lastFlushAt = new Date()
        this.#emit('audit:flushed', { store: storeName, events: chained, count: chained.length })
        this.#resolveCoupled(eventIds)
        return
      } catch (error) {
        lastError = error
        attempts++
        this.#retried++

        if (attempts >= maxAttempts) {
          this.#deadLetterHandler(batch)
          this.#deadLettered += batch.length
          this.#emit('audit:dead_letter', { events: batch, count: batch.length, error: lastError })
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

  #emit<Name extends keyof AuditRuntimeEvents>(
    event: Name,
    payload: AuditRuntimeEvents[Name]
  ): void {
    if (!this.#emitter) return
    void this.#emitter.emit(event, payload).catch(() => {})
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
  appendDeadLetters('storage/audit-dlq', events)
}

function appendDeadLetters(dlqPath: string, events: AuditEvent[]): void {
  const line = events.map((event) => JSON.stringify(event)).join('\n')
  mkdirSync(dirname(dlqPath), { recursive: true })
  appendFileSync(dlqPath, `${line}\n`)
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
