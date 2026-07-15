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

Physical pruning from the Lucid store is deliberately privileged. Configure a maintenance callback that establishes the database permission inside the pruning transaction:

```ts
stores.lucid({
  maintenance: async (transaction) => {
    await transaction.rawQuery("select set_config('audit.maintenance', 'prune', true)")
  },
})
```

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

1. Resolves the retention cutoff for the contiguous expired prefix of each stream.
2. Groups that prefix into a segment, retaining the stream head.
3. Calls `archive(segment)` before deletion (if configured).
4. Executes the configured privileged maintenance operation, then deletes the archived range.
5. Records a checkpoint so verification can continue across the pruned range.

## Archive-before-delete

For compliance, archive segments to WORM/object-lock storage before deletion. The `archive` hook receives:

```ts
interface RetentionSegment {
  idempotencyKey: string // `${stream}:${fromSeq}:${toSeq}`
  stream: string
  event: string
  fromSeq: number
  toSeq: number
  count: number
  fromCreatedAt: string
  toCreatedAt: string
}
```

## Partitioning for scale

On PostgreSQL, partition `audits` by month. See [operations.md](./operations.md) for DDL. Pruning can drop whole partitions when every row inside is expired.
