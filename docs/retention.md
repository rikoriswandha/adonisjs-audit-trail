# Retention & pruning

Audit data grows forever by default. Use retention policies and `node ace audit:prune` to remove old events safely.

## Retention configuration

```ts
retention: {
  default: '730 days',
  perEvent: {
    'auth.login': '90 days',
    'model.created': '365 days',
  },
  archive: async (segment) => {
    // Push NDJSON segment to object-lock storage
  },
}
```

Policies accept any interval string understood by the underlying duration parser (e.g. `30 days`, `6 months`, `2 years`).

## Prune command

```bash
# Dry run
node ace audit:prune --dry-run

# Actually prune
node ace audit:prune

# Use a dedicated maintenance connection
node ace audit:prune --connection=audit_maintainer
```

The command:

1. Resolves the retention cutoff per event type.
2. Groups candidate rows into segments.
3. Calls `archive(segment)` for each segment (if configured).
4. Deletes rows oldest-first.
5. Never deletes the per-stream head row, preserving chain continuity.

## Archive-before-delete

For compliance, archive segments to WORM/object-lock storage before deletion. The `archive` hook receives:

```ts
interface RetentionSegment {
  stream: string
  event: string
  fromSeq: number
  toSeq: number
  from: Date
  to: Date
  rows: ChainedAuditEvent[]
}
```

## Partitioning for scale

On PostgreSQL, partition `audits` by month. See [operations.md](./operations.md) for DDL. Pruning can drop whole partitions when every row inside is expired.
