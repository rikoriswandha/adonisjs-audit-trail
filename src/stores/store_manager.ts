import type { AuditStoreContract } from '../types.js'

export default class StoreManager {
  constructor(protected config: Record<string, unknown>) {}

  use(_name: string): AuditStoreContract {
    throw new Error('StoreManager.use: not implemented')
  }
}
