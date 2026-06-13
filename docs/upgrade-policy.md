# Upgrade policy

## Semantic versioning

- **Patch**: bug fixes, docs, internal refactorings that do not change hashes or public APIs.
- **Minor**: new stores, new config options, new commands, backward-compatible additions.
- **Major**: changes to the canonical hash field list, serialization format, or schema version.

## Frozen hash fields

The set of fields included in the canonical hash is frozen per `schema_version`. Changing it would break existing chains and requires a new `schema_version`. The current version is `1`.

| `schema_version` | Fields in hash | Introduced |
| ---------------- | -------------- | ---------- |
| `1` | `id`, `seq`, `stream`, `event`, `auditable_type`, `auditable_id`, `old_values`, `new_values`, `metadata`, `actor_type`, `actor_id`, `tenant_id`, `created_at`, `schema_version`, `prev_hash` | v1.0.0 |

## Adding fields

New transport-only or display-only fields (e.g. `actor_label`, `tags`) are added **outside** the hash. Existing chains continue to verify.

## Hash algorithm

SHA-256 is the only supported hash algorithm. A future change would be a major version bump.

## Database migrations

Migrations are additive only. Pruning relies on `seq` order, so structural changes to the `audits` table must preserve `seq` and the hash-field columns.
