# Configuration reference

Configuration lives in `config/audit.ts` and follows the AdonisJS v7 manager/driver pattern (`defineConfig` + `stores`).

```ts
import { defineConfig, stores } from '@rikology/adonisjs-audit-trail'

export default defineConfig({
  default: 'lucid',
  guarantee: 'best-effort',

  stores: {
    lucid: stores.lucid({
      connection: 'audit',
      table: 'audits',
    }),

    siem: stores.stream({
      destination: 'stdout',
      format: 'ndjson',
    }),

    all: stores.fanout({
      primary: 'lucid',
      mirrors: ['siem'],
      mirrorFailure: 'log',
    }),
  },

  redaction: {
    global: ['password', 'token', '*.secret'],
    mode: 'mask',
    saltEnvVar: 'AUDIT_REDACTION_SALT',
  },

  retention: {
    default: '730 days',
    perEvent: { 'auth.login': '90 days' },
  },

  chain: {
    streamBy: 'tenant',
  },

  queue: {
    maxBatchSize: 200,
    flushIntervalMs: 250,
    capacity: 10_000,
    overflow: 'dropOldest',
  },

  payloadMaxBytes: 32_768,
})
```

## Top-level options

| Option          | Type                                                    | Default                                  | Description |
| --------------- | ------------------------------------------------------- | ---------------------------------------- | ----------- |
| `default`       | `keyof stores`                                         | `'lucid'`                                | Name of the default store to use. |
| `guarantee`     | `'best-effort' \| 'request-coupled' \| 'transactional-outbox'` | `'best-effort'`                          | Default delivery guarantee. |
| `stores`        | `Record<string, AuditStoreFactory \| ConfigProvider>`  | *(required)*                             | Store driver definitions. |
| `redaction`     | `AuditConfig['redaction']`                             | `{ mode: 'mask' }`                       | Global redaction rules. |
| `retention`     | `AuditConfig['retention']`                             | `{ default: '730 days' }`                | Retention policy for `audit:prune`. |
| `chain`         | `AuditConfig['chain']`                                 | `{ streamBy: 'global' }`                 | Hash-chain stream and anchor settings. |
| `queue`         | `AuditConfig['queue']`                                 | `{ maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' }` | In-memory pipeline settings. |
| `outbox`        | `AuditOutboxConfig`                                    | `{ table: 'audit_outbox' }`              | Source outbox connection, table, executor, and retry settings. |
| `captureAuthEvents` | `boolean`                                             | `true` except `false` for `'transactional-outbox'` | Subscribe to automatic auth emitter events. In `transactional-outbox` mode it must remain `false`; setting it to `true` is rejected. |
| `payloadMaxBytes` | `number`                                              | `32_768`                                 | Max size of `old_values`/`new_values`/`metadata` before truncation. |

## Auth emitter capture

`captureAuthEvents` controls automatic capture from the AdonisJS auth event emitter. It defaults to `true` in `best-effort` and `request-coupled` modes, preserving request-coupled and best-effort capture unless you explicitly set it to `false`.

Transactional outbox is different: it defaults to `false`, and `captureAuthEvents: true` is an invalid configuration. Auth emitter payloads do not include the caller-owned business transaction needed to persist an outbox intent fail-closed. Enabling the listener would therefore promise an atomicity guarantee it cannot keep.

For an auth-related operation that requires atomic audit intent, emit the event explicitly inside the business transaction instead:

```ts
await db.transaction(async (trx) => {
  // Perform the auth-related business write with trx.
  await audit.log('auth.login').withTransaction(trx).commit()
})
```

The explicit event joins `trx`; the outbox drainer delivers it to the target audit store asynchronously after commit.

## Environment variables

Add to `start/env.ts`:

```ts
AUDIT_REDACTION_SALT: Env.schema.string.optional(),
```

A salt is required when `redaction.mode` is `'hash'`.

## Typed event names

Register domain events in `start/audit_events.ts`:

```ts
declare module '@rikology/adonisjs-audit-trail/types' {
  interface AuditEvents {
    'invoice.approved': true
    'document.exported': true
  }
}
```

`audit.log()` will then autocomplete the registered names.
