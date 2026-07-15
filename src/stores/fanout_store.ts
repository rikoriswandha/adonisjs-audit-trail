import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '../types.js'
import { AuditStoreError } from '../core/errors.js'

export interface FanoutStoreOptions {
  primary: string | AuditStoreContract
  mirrors?: (string | AuditStoreContract)[]
  mirrorFailure?: 'log' | 'throw'
}

export default class FanoutStore implements AuditStoreContract {
  readonly #primaryRef: string | AuditStoreContract
  readonly #mirrorRefs: (string | AuditStoreContract)[]
  readonly #mirrorFailure: 'log' | 'throw'
  #primary?: AuditStoreContract
  #mirrors?: AuditStoreContract[]

  constructor(options: FanoutStoreOptions) {
    if (!options.primary) {
      throw new AuditStoreError('FanoutStore requires a primary store')
    }

    this.#primaryRef = options.primary
    this.#mirrorRefs = options.mirrors ?? []
    this.#mirrorFailure = options.mirrorFailure ?? 'log'

    if (typeof options.primary !== 'string') {
      this.#primary = options.primary
    }

    const instanceMirrors = this.#mirrorRefs.filter(
      (ref) => typeof ref !== 'string'
    ) as AuditStoreContract[]
    if (instanceMirrors.length > 0) {
      this.#mirrors = instanceMirrors
    }
  }

  bindStores(stores: Record<string, AuditStoreContract>): void {
    if (!this.#primary) {
      this.#primary = this.#resolveStore(this.#primaryRef, stores)
    }

    const resolvedMirrors = this.#mirrorRefs.map((ref) => this.#resolveStore(ref, stores))
    this.#mirrors = resolvedMirrors.length > 0 ? resolvedMirrors : this.#mirrors
  }

  async write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    const primary = this.#requirePrimary()
    const mirrors = this.#mirrors ?? []

    if (this.#mirrorFailure === 'throw') {
      try {
        await Promise.all(mirrors.map((mirror) => mirror.write(batch)))
      } catch (error) {
        throw new AuditStoreError(
          `Fanout mirror failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      return primary.write(batch)
    }

    const chained = await primary.write(batch)
    await Promise.all(
      mirrors.map(async (mirror) => {
        try {
          await mirror.write(batch)
        } catch (error) {
          console.error(
            `Audit fanout mirror failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      })
    )

    return chained
  }

  async head(stream: string): Promise<{ seq: number; hash: string } | null> {
    return this.#requirePrimary().head(stream)
  }

  async *verify(
    stream: string,
    range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    yield* this.#requirePrimary().verify(stream, range)
  }

  async prune(policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    return this.#requirePrimary().prune(policy)
  }

  #resolveStore(
    ref: string | AuditStoreContract,
    stores: Record<string, AuditStoreContract>
  ): AuditStoreContract {
    if (typeof ref !== 'string') {
      return ref
    }

    const store = stores[ref]
    if (!store) {
      throw new AuditStoreError(`FanoutStore references unknown store "${ref}"`)
    }

    if (store instanceof FanoutStore) {
      store.bindStores(stores)
    }

    return store
  }

  #requirePrimary(): AuditStoreContract {
    if (!this.#primary) {
      throw new AuditStoreError('FanoutStore has not been bound to configured stores')
    }
    return this.#primary
  }
}
