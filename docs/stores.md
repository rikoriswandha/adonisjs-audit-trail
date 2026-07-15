# Stores

The storage layer is a manager/driver system mirroring AdonisJS patterns (hash, drive, encryption).

## Built-in stores

### `lucid` (default)

Stores audits in a SQL table via `@adonisjs/lucid`. Supports SQLite, PostgreSQL, and MySQL.

```ts
stores.lucid({
  connection: 'audit',
  table: 'audits',
})
```

- Uses per-stream advisory locks (Postgres/MySQL) or single-writer serialization (SQLite) to keep `seq` gapless.
- Supports query API, verification, and pruning.

### `stream`

Writes NDJSON to stdout, a file, or any `Writable`.

```ts
stores.stream({
  destination: 'stdout',
  format: 'ndjson',
})
```

For file destinations, the store keeps a sidecar head file so the chain survives restarts.

### `http`

POSTs canonical batches to a collector.

```ts
stores.http({
  url: 'https://siem.example.com/audits',
  signature: {
    secretEnvVar: 'AUDIT_COLLECTOR_SECRET',
  },
  maxRetainedPerStream: 100_000,
})
```

The store signs each batch with HMAC-SHA256. If the collector returns the new chain head, it is used for the next batch; otherwise local chaining is used.

#### In-memory verification window

`maxRetainedPerStream` bounds how many of the most recent chained events the HTTP store keeps in memory per stream for `verify()` and `prune()`. It defaults to `100_000`; set it to `0` to retain every event in memory, matching the legacy unbounded behavior. When a cap is configured, `verify()` and `prune()` cover only the retained window.

### `fanout`

Writes to a primary store and mirrors to one or more secondary stores.

```ts
stores.fanout({
  primary: 'lucid',
  mirrors: ['siem'],
  mirrorFailure: 'log', // 'log' | 'throw'
})
```

Only the primary store's chain result is returned; mirror failures are logged or propagated based on `mirrorFailure`.

## Switching stores

```ts
export default defineConfig({
  default: 'all',
})
```

Per-call override for domain events:

```ts
await audit.log('invoice.approved').to('siem').commit()
```

## Custom store

Provide an `AuditStoreFactory` in `defineConfig`:

```ts
import type {
  AuditEvent,
  AuditStoreContract,
  ChainedAuditEvent,
  PruneReport,
  ResolvedRetentionPolicy,
  VerifyReport,
} from '@rikology/adonisjs-audit-trail'
import type { ApplicationService } from '@adonisjs/core/types'

export async function myStore(_app: ApplicationService): Promise<AuditStoreContract> {
  return {
    async write(_batch: AuditEvent[]): Promise<ChainedAuditEvent[]> {
      return []
    },
    async head(_stream: string) {
      return null
    },
    async *verify(_stream: string): AsyncIterable<VerifyReport> {},
    async prune(_policy: ResolvedRetentionPolicy): Promise<PruneReport> {
      return { streams: [], totalPruned: 0, perEvent: {} }
    },
  }
}
```
