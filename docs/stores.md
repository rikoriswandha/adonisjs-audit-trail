# Stores

The storage layer is a manager/driver system mirroring AdonisJS patterns (hash, drive, encryption).

## Built-in stores

### `lucid` (default)

Stores audits in a SQL table via `@adonisjs/lucid`. Supports SQLite, PostgreSQL, and MySQL.

```ts
stores.lucid({
  connection: 'audit',
  table: 'audits',
  enforceImmutability: true,
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
  secret: process.env.AUDIT_COLLECTOR_SECRET,
  idempotencyKey: (batch) => batch[0].id,
})
```

The store signs each batch with HMAC-SHA256. If the collector returns the new chain head, it is used for the next batch; otherwise local chaining is used.

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

Implement `AuditStoreContract`:

```ts
export const myStore = stores.define({
  async write(batch) {
    // persist, chain, return ChainedAuditEvent[]
  },
  async head(stream) {
    // return { seq, hash } | null
  },
  async* verify(stream, range) {
    // yield VerifyReport
  },
})
```
