# Operations Guide

This guide covers production operations for `@rikology/adonisjs-audit-trail`.

## PostgreSQL monthly partitioning

For high-volume workloads, partition the `audits` table by month. The hash chain still verifies per `stream` because `seq` is globally unique per stream, regardless of which partition holds the row.

```sql
-- Replace with your actual schema/table owner
CREATE TABLE audits_partitioned (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL,
  stream varchar(64) NOT NULL,
  event varchar(128) NOT NULL,
  auditable_type varchar(128),
  auditable_id varchar(64),
  old_values jsonb,
  new_values jsonb,
  metadata jsonb,
  actor_type varchar(64) NOT NULL,
  actor_id varchar(64),
  actor_label varchar(255),
  tenant_id varchar(64),
  request_id varchar(64),
  correlation_id varchar(64),
  ip_address varchar(45),
  user_agent varchar(512),
  url varchar(2048),
  http_method varchar(10),
  hash varchar(64) NOT NULL,
  prev_hash varchar(64) NOT NULL,
  schema_version varchar(8) NOT NULL DEFAULT '1',
  created_at timestamptz NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'
) PARTITION BY RANGE (created_at);

CREATE INDEX audits_stream_seq ON audits_partitioned (stream, seq);
CREATE INDEX audits_auditable ON audits_partitioned (auditable_type, auditable_id, seq);
CREATE INDEX audits_actor ON audits_partitioned (actor_type, actor_id, seq);
CREATE INDEX audits_event_created_at ON audits_partitioned (event, created_at);
CREATE INDEX audits_tenant ON audits_partitioned (tenant_id);

-- Create monthly partitions. Adjust range as needed.
CREATE TABLE audits_y2026m07 PARTITION OF audits_partitioned
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audits_y2026m08 PARTITION OF audits_partitioned
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

Create future partitions with a scheduled job (pg_cron, external scheduler, or migration). Pruning can drop whole partitions when all rows inside are expired.

## INSERT-only role grants

Enforce append-only behavior at the database layer. The application role should only `INSERT` and `SELECT`. Pruning runs under a separate maintenance role.

```sql
-- Application role
CREATE ROLE audit_app WITH LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA public TO audit_app;
GRANT INSERT, SELECT ON audits TO audit_app;
GRANT SELECT, INSERT, UPDATE ON audit_outbox TO audit_app; -- drainer updates attempts/claimed_at
GRANT USAGE, SELECT ON SEQUENCE audits_seq_seq TO audit_app;

-- Maintenance role for prune/replay commands
CREATE ROLE audit_maintainer WITH LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA public TO audit_maintainer;
GRANT SELECT, DELETE ON audits TO audit_maintainer;
GRANT ALL ON audit_outbox TO audit_maintainer;
```

Optionally enable the DB-level immutability trigger via `configure` (guards against `UPDATE`/`DELETE` even for superusers with table grants).

## Separate audit connection

Route audit I/O to a dedicated connection (or even a separate database/replica) in `config/audit.ts`:

```ts
import { defineConfig, stores } from '@rikology/adonisjs-audit-trail'

export default defineConfig({
  default: 'lucid',
  stores: {
    lucid: stores.lucid({
      connection: 'audit',
      table: 'audits',
    }),
  },
})
```

And in `config/database.ts`:

```ts
connections: {
  audit: {
    client: 'pg',
    connection: {
      host: process.env.DB_AUDIT_HOST,
      port: Number(process.env.DB_AUDIT_PORT),
      user: process.env.DB_AUDIT_USER,
      password: process.env.DB_AUDIT_PASSWORD,
      database: process.env.DB_AUDIT_DATABASE,
    },
  },
}
```

## DLQ monitoring

The pipeline writes dead-letter events to `storage/audit-dlq/` as NDJSON files when retries are exhausted. Monitor this directory with your log/observability stack.

```bash
# Example: count dead-lettered events in the last hour
find storage/audit-dlq -name '*.ndjson' -mmin -60 -exec wc -l {} +
```

## Alert on `audit:dropped`

Register a listener for the `audit:dropped` event to page when the in-memory queue overflows:

```ts
import emitter from '@adonisjs/core/services/emitter'

emitter.on('audit:dropped', ({ count, strategy }) => {
  console.error(`Audit events dropped: count=${count} strategy=${strategy}`)
  // Send to Datadog/PagerDuty/etc.
})
```

Recommended alerts:

| Condition | Severity | Action |
|---|---|---|
| `audit:dropped` count > 0 | P1 | Page on-call; queue capacity or store throughput issue |
| `audit:dead_letter` count > 0 | P1 | Investigate store health |
| `audit:verify` fails in CI/cron | P0 | Possible tampering or chain bug |
| DLQ directory non-empty | P2 | Replay or inspect events |

## Verification cron

Run `node ace audit:verify` nightly in CI or via cron. Exit code is non-zero on chain breaks.

```bash
#!/bin/bash
node ace audit:verify --stream=default
if [ $? -ne 0 ]; then
  echo "Audit chain verification failed"
  exit 1
fi
```

## Replay outbox after extended downtime

If the outbox drainer was stopped for a long time, drain pending rows manually:

```bash
node ace audit:replay-outbox
```

The drainer is idempotent (uses `claimed_at` + `attempts`), so replay is safe.
