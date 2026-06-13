import type { AuditStoreContract } from '../types.js'
import type { ResolvedAuditConfig } from '../define_config.js'

export default class StoreManager {
  #stores: Record<string, AuditStoreContract>
  #default: string

  constructor(config: ResolvedAuditConfig) {
    this.#stores = config.stores as unknown as Record<string, AuditStoreContract>
    this.#default = String(config.default)
  }

  use(name?: string): AuditStoreContract {
    const storeName = name ?? this.#default
    const store = this.#stores[storeName]
    if (!store) throw new Error(`Audit store "${storeName}" is not configured`)
    return store
  }

  get default(): string {
    return this.#default
  }
}
