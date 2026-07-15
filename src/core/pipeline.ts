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
import type { SuccessfulDeliveryNotifier } from './successful_delivery_notifier.js'

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
  notifier: SuccessfulDeliveryNotifier
}

export default class AuditPipeline {
  #config: PipelineConfig
  #store: AuditStoreContract
  #storeName: string
  #routeStore: (event: AuditEvent) => PipelineStoreRoute
  #redactor?: { redact: (data: Record<string, unknown>) => Record<string, unknown> }
  #deadLetterHandler: (events: AuditEvent[]) => void
  #notifier: SuccessfulDeliveryNotifier
  #emitter?: PipelineEmitter
  #buffer: AuditEvent[]
  #head = 0
  #tail = 0
  #size = 0
  #activeFlush: Promise<void> | null = null
  #flushTimer: ReturnType<typeof setInterval> | null = null
  #started = false
  #accepting = true
  #capacityWaiters: (() => void)[] = []

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
    this.#notifier = deps.notifier
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

  async enqueue(event: AuditEvent): Promise<boolean> {
    if (this.#redactor) {
      event = this.#redactEvent(event)
    }
    while (this.#size >= this.#config.capacity) {
      if (this.#config.overflow !== 'block') {
        if (!this.#handleOverflow(event)) return false
        break
      }

      if (!this.#accepting) return false
      void this.#flush()
      await this.#waitForCapacity()
    }

    if (!this.#accepting) return false

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
    this.#accepting = false
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer)
      this.#flushTimer = null
    }
    this.#wakeCapacityWaiters()

    const deadline = Date.now() + deadlineMs
    while (this.#size > 0 && Date.now() < deadline) {
      const active = this.#flush()
      const remaining = deadline - Date.now()
      await Promise.race([active, sleep(Math.max(0, remaining))])
    }

    // Never dead-letter work while a store write may still complete.
    if (this.#activeFlush) {
      await this.#activeFlush
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

    return false
  }

  #dropOldest(): AuditEvent {
    const dropped = this.#buffer[this.#head]
    this.#buffer[this.#head] = undefined as unknown as AuditEvent
    this.#head = (this.#head + 1) % this.#config.capacity
    this.#size--
    this.#dropped++
    this.#wakeCapacityWaiters()
    return dropped
  }

  static createFileDeadLetterHandler(dlqPath: string): (events: AuditEvent[]) => void {
    return (events) => appendDeadLetters(dlqPath, events)
  }

  #flush(): Promise<void> {
    if (this.#activeFlush) return this.#activeFlush
    if (this.#size === 0) return Promise.resolve()

    const active = this.#flushBatch()
    this.#activeFlush = active
    void active.then(
      () => this.#completeFlush(active),
      () => this.#completeFlush(active)
    )
    return active
  }

  async #flushBatch(): Promise<void> {
    const batch = this.#peekBuffer()
    const groups = this.#groupByStore(batch)

    for (const group of groups.values()) {
      const written = await this.#writeWithRetry(group.store, group.events)
      if (written) {
        this.#resolveCoupled(group.events.map((event) => event.id))
      }
    }

    this.#removeBuffered(batch.length)
  }

  #completeFlush(active: Promise<void>): void {
    if (this.#activeFlush !== active) return
    this.#activeFlush = null
    this.#wakeCapacityWaiters()
    if (this.#size >= this.#config.maxBatchSize) {
      void this.#flush()
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

  async #writeWithRetry(store: AuditStoreContract, batch: AuditEvent[]): Promise<boolean> {
    let attempts = 0
    const maxAttempts = 5
    const baseDelay = this.#config.retryBaseDelayMs ?? 100
    let lastError: unknown = null

    while (attempts < maxAttempts) {
      try {
        const chained = await store.write(batch)
        this.#written += batch.length
        this.#lastFlushAt = new Date()
        try {
          await this.#notifier.notify(store, chained)
        } catch {
          // A store has already accepted the batch; notification cannot trigger a replay.
        }
        return true
      } catch (error) {
        lastError = error
        attempts++
        this.#retried++

        if (attempts >= maxAttempts) {
          this.#deadLetterHandler(batch)
          this.#deadLettered += batch.length
          this.#emit('audit:dead_letter', { events: batch, count: batch.length, error: lastError })
          return false
        }

        const delay = 2 ** attempts * baseDelay + Math.random() * 100
        await sleep(delay)
      }
    }

    return false
  }

  #peekBuffer(): AuditEvent[] {
    const batchSize = Math.min(this.#size, this.#config.maxBatchSize)
    const batch: AuditEvent[] = []
    for (let i = 0; i < batchSize; i++) {
      batch.push(this.#buffer[(this.#head + i) % this.#config.capacity]!)
    }
    return batch
  }

  #removeBuffered(count: number): void {
    for (let i = 0; i < count; i++) {
      this.#buffer[this.#head] = undefined as unknown as AuditEvent
      this.#head = (this.#head + 1) % this.#config.capacity
      this.#size--
    }
    this.#wakeCapacityWaiters()
  }

  #drainBuffer(): AuditEvent[] {
    const batch = this.#peekBuffer()
    this.#removeBuffered(batch.length)
    return batch
  }

  #waitForCapacity(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#capacityWaiters.push(resolve)
    return promise
  }

  #wakeCapacityWaiters(): void {
    const waiters = this.#capacityWaiters
    this.#capacityWaiters = []
    for (const wake of waiters) wake()
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
