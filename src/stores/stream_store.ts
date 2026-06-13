import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  ResolvedRetentionPolicy,
  VerifyReport,
  PruneReport,
} from '../types.js'

export default class StreamStore implements AuditStoreContract {
  async write(_batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    throw new Error('StreamStore.write: not implemented')
  }

  async head(_stream: string): Promise<{ seq: number; hash: string } | null> {
    throw new Error('StreamStore.head: not implemented')
  }

  async *verify(
    _stream: string,
    _range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    throw new Error('StreamStore.verify: not implemented')
  }

  async prune(_policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    throw new Error('StreamStore.prune: not implemented')
  }
}
