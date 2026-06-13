import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  ResolvedRetentionPolicy,
  VerifyReport,
  PruneReport,
} from '../types.js'

export default class HttpStore implements AuditStoreContract {
  async write(_batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
    throw new Error('HttpStore.write: not implemented')
  }

  async head(_stream: string): Promise<{ seq: number; hash: string } | null> {
    throw new Error('HttpStore.head: not implemented')
  }

  async *verify(
    _stream: string,
    _range?: { fromSeq?: number; toSeq?: number }
  ): AsyncGenerator<VerifyReport> {
    throw new Error('HttpStore.verify: not implemented')
  }

  async prune(_policy: ResolvedRetentionPolicy): Promise<PruneReport> {
    throw new Error('HttpStore.prune: not implemented')
  }
}
