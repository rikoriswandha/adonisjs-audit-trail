import type { AuditRuntimeEvents, AuditStoreContract, ChainedAuditEvent } from '../types.js'
import type { AnchorService } from './anchor.js'

export interface AuditDeliveryEmitter {
  emit<Name extends keyof AuditRuntimeEvents>(
    event: Name,
    payload: AuditRuntimeEvents[Name]
  ): Promise<void>
}

export interface SuccessfulDeliveryNotifier {
  notify(store: AuditStoreContract, events: ChainedAuditEvent[]): Promise<void>
}

export class RuntimeSuccessfulDeliveryNotifier implements SuccessfulDeliveryNotifier {
  readonly #emitter: AuditDeliveryEmitter
  readonly #anchor?: AnchorService
  readonly #deliveredEventIds = new Set<string>()

  constructor(emitter: AuditDeliveryEmitter, anchor?: AnchorService) {
    this.#emitter = emitter
    this.#anchor = anchor
  }

  async notify(store: AuditStoreContract, events: ChainedAuditEvent[]): Promise<void> {
    const delivered = events.filter((event) => {
      if (this.#deliveredEventIds.has(event.id)) return false
      this.#deliveredEventIds.add(event.id)
      return true
    })

    if (delivered.length === 0) return

    const storeName = store.constructor.name
    try {
      await this.#emitter.emit('audit:flushed', {
        store: storeName,
        events: delivered,
        count: delivered.length,
      })
    } catch {
      // A delivery has already succeeded; observer failures must not replay it.
    }

    try {
      await this.#anchor?.onFlush(delivered)
    } catch {
      // A delivery has already succeeded; anchoring failures must not replay it.
    }
  }
}
