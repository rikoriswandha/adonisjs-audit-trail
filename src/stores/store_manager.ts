import { AuditStoreConnectionError, AuditStoreError } from '../core/errors.js'
import type { AuditEvent, AuditStoreContract } from '../types.js'
import type { ResolvedAuditConfig } from '../define_config.js'

export default class StoreManager {
  #stores: Record<string, AuditStoreContract>
  #default: string

  constructor(config: ResolvedAuditConfig) {
    this.#stores = config.stores as unknown as Record<string, AuditStoreContract>
    this.#default = String(config.default)
  }

  use(name?: string, connection?: string): AuditStoreContract {
    const storeName = name ?? this.#default
    const store = this.#stores[storeName]
    if (!store) {
      throw new AuditStoreError(`Audit store "${storeName}" is not configured`)
    }

    if (connection === undefined) {
      return store
    }

    if (typeof store.withConnection === 'function') {
      return store.withConnection(connection)
    }

    throw new AuditStoreConnectionError(
      `Audit store "${storeName}" does not support connection selection`
    )
  }

  route(event: AuditEvent): { name: string; store: AuditStoreContract } {
    const routed = event.metadata?.auditStore
    const storeName = typeof routed === 'string' ? routed : this.#default
    return { name: storeName, store: this.use(storeName) }
  }

  get default(): string {
    return this.#default
  }
}
