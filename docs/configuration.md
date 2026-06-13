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
      enforceImmutability: true,
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
    salt: process.env.AUDIT_REDACTION_SALT,
  },

  retention: {
    default: '730 days',
    perEvent: { 'auth.login': '90 days' },
  },

  chain: {
    enabled: true,
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
| `default`       | `string`                                                | `'lucid'`                                | Name of the default store to use. |
| `guarantee`     | `'best-effort' \| 'request-coupled' \| 'transactional-outbox'` | `'best-effort'`                          | Default delivery guarantee. |
| `stores`        | `Record<string, AuditStoreFactory>`                     | *(required)*                             | Store driver definitions. |
| `redaction`     | `RedactionConfig`                                       | `{ mode: 'mask' }`                       | Global redaction rules. |
| `retention`     | `RetentionConfig`                                       | `{ default: '730 days' }`                | Retention policy for `audit:prune`. |
| `chain`         | `ChainConfig`                                           | `{ enabled: true, streamBy: 'global' }`  | Hash-chain settings. |
| `queue`         | `QueueConfig`                                           | `{ maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' }` | In-memory pipeline settings. |
| `payloadMaxBytes` | `number`                                              | `32_768`                                 | Max size of `old_values`/`new_values`/`metadata` before truncation. |

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
