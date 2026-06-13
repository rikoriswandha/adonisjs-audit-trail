# Tamper evidence & verification

Every audit record is linked into a per-stream SHA-256 hash chain. Altering any record breaks every subsequent hash.

## How the chain works

1. Each event is assigned a server-side `seq` (bigserial) per stream.
2. The store reads the current stream head (`seq` + `hash`).
3. `hash = sha256(canonical(event))`, where `canonical` covers a frozen set of fields plus the previous hash.
4. Genesis `prev_hash` for a new stream is 64 zeros.

The canonical payload includes:

`id`, `seq`, `stream`, `event`, `auditable_type`, `auditable_id`, `old_values`, `new_values`, `metadata`, `actor_type`, `actor_id`, `tenant_id`, `created_at`, `schema_version`, `prev_hash`.

Excluded fields (safe to backfill): `actor_label`, `tags`, transport-only fields.

## Verify a stream

```bash
# Verify all streams
node ace audit:verify

# Verify a specific stream and range
node ace audit:verify --stream=tenant:acme --from-seq=1 --to-seq=10000

# CI-friendly JSON output
node ace audit:verify --json
```

Exit codes:

- `0`: all checked streams are valid.
- `1`: at least one chain break detected.

## Detecting truncation

A pure hash chain detects tampering but not whole-suffix deletion. Enable anchoring to catch truncation:

```ts
chain: {
  enabled: true,
  anchor: {
    every: 1000,
    publish: stores.anchor.file({ path: 'storage/audit-anchors.ndjson' }),
  },
}
```

Anchors record the current chain head periodically. Use `--check-anchors` to compare the database head against the latest anchor.

## What to do when verification fails

1. Stop prune/archive jobs.
2. Inspect the `VerifyReport` to find the first invalid `seq`.
3. Compare backups/replicas for the affected stream.
4. Treat the break as a security incident; file according to your incident-response process.
5. Do not attempt to "repair" the chain by rewriting rows; append a compensating audit event explaining the incident.
