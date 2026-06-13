import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditActor } from './types.js'

export interface AuditContextStore {
  actor?: AuditActor | (() => Promise<AuditActor | null>)
  tenantId?: string
  requestId?: string
  correlationId?: string
  ip?: string
  userAgent?: string
  url?: string
  httpMethod?: string
}

export class AuditContext {
  #als = new AsyncLocalStorage<AuditContextStore>()

  run<T>(store: AuditContextStore, fn: () => T): T {
    return this.#als.run(store, fn)
  }

  get(): AuditContextStore | undefined {
    return this.#als.getStore()
  }

  set(patch: Partial<AuditContextStore>): void {
    const store = this.#als.getStore()
    if (store) Object.assign(store, patch)
  }
}

export const auditContext = new AuditContext()
