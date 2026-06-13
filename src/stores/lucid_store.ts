import type {
  AuditEvent,
  AuditStoreContract,
  ChainContext,
  ChainedAuditEvent,
  ResolvedRetentionPolicy,
  VerifyReport,
  PruneReport,
} from '../types.js'

export default class LucidStore implements AuditStoreContract {
  async write(_batch: AuditEvent[], _chainCtx: ChainContext): Promise<ChainedAuditEvent[]> {
    throw new Error('LucidStore.write: not implemented')
  }

  async head(_stream: string): Promise<{ seq: number; hash: string } | null> {
    throw new Error('LucidStore.head: not implemented')
  }

  async *verify(
    _stream: string,
    _range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    throw new Error('LucidStore.verify: not implemented')
  }

  async prune(_policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    throw new Error('LucidStore.prune: not implemented')
  }
}
