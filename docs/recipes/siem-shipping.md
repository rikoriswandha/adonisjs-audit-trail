# Recipe: SIEM shipping

Ship audit events to a SIEM or log aggregator with the `stream` store.

## NDJSON to stdout

```ts
export default defineConfig({
  default: 'siem',
  stores: {
    siem: stores.stream({
      destination: 'stdout',
      format: 'ndjson',
    }),
  },
})
```

Forward container stdout to your log shipper (Fluent Bit, Vector, Datadog Agent, etc.).

## NDJSON to file

```ts
stores.siem: stores.stream({
  destination: 'storage/logs/audits.ndjson',
  format: 'ndjson',
})
```

Rotate the file with `logrotate` or a sidecar. The store writes a sidecar head file (`audits.head.json`) so the chain survives rotation.

## Fanout: SQL + SIEM

Keep the authoritative chain in SQL and mirror to SIEM:

```ts
export default defineConfig({
  default: 'all',
  stores: {
    lucid: stores.lucid({ connection: 'audit' }),
    siem: stores.stream({ destination: 'stdout', format: 'ndjson' }),
    all: stores.fanout({ primary: 'lucid', mirrors: ['siem'], mirrorFailure: 'log' }),
  },
})
```

## HTTP collector

For collectors that accept batches:

```ts
stores.siem: stores.http({
  url: process.env.AUDIT_SIEM_URL!,
  secret: process.env.AUDIT_SIEM_SECRET!,
})
```

Each batch is signed with HMAC-SHA256. Verify the signature on the collector before trusting the payload.

## Recommended SIEM fields

Each NDJSON line contains the full `AuditEvent` plus `seq`, `hash`, and `prevHash`. Map these to your SIEM schema:

| Audit field | Common SIEM field |
| ----------- | ----------------- |
| `event` | `event.action` |
| `actor.type` / `actor.id` | `user.*` / `process.*` |
| `ipAddress` | `source.ip` |
| `userAgent` | `user_agent.original` |
| `tenantId` | `organization.id` |
| `hash` / `prevHash` | custom integrity fields |

## Alerting

Alert on `audit:dropped` and `audit:dead_letter` events to detect pipeline back-pressure.
