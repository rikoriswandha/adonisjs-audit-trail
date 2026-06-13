# `@rikology/adonisjs-audit-trail`

Production-grade, tamper-evident audit trail for [AdonisJS v7](https://adonisjs.com).

[![checks](https://github.com/rikology/adonisjs-audit-trail/actions/workflows/checks.yml/badge.svg)](https://github.com/rikology/adonisjs-audit-trail/actions/workflows/checks.yml)
[![npm version](https://img.shields.io/npm/v/@rikology/adonisjs-audit-trail)](https://www.npmjs.com/package/@rikology/adonisjs-audit-trail)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

- **Automatic** model auditing via a Lucid mixin.
- **Explicit** domain events via a fluent API.
- **Tamper-evident** SHA-256 hash chains with `node ace audit:verify`.
- **Asynchronous, batched write pipeline** that never blocks the request path.
- **Pluggable stores**: SQL (Lucid), NDJSON stream, HTTP collector, or fanout.
- **PII-aware** redaction, masking, hashing, and crypto-shredding support.
- **Type-safe** end-to-end with generated event-name unions and v7 transformers.

## Requirements

- Node.js `>= 24`
- AdonisJS v7 (`@adonisjs/core@^7`)
- TypeScript 5.9+

## Quick start

### 1. Install

```bash
node ace add @rikology/adonisjs-audit-trail
```

The configure command will publish `config/audit.ts`, migrations, the audit transformer, and register the provider, commands, and middleware.

### 2. Run migrations

```bash
node ace migration:run
```

### 3. Add the mixin to a model

```ts
import { compose } from '@adonisjs/core/helpers'
import { BaseModel } from '@adonisjs/lucid/orm'
import { Auditable } from '@rikology/adonisjs-audit-trail/auditable'

export default class Invoice extends compose(BaseModel, Auditable) {
  static auditConfig = {
    redact: ['iban'],
    tags: ['billing'],
  }

  // ... columns
}
```

Every `create`, `update`, `delete`, and restore now produces an immutable audit record automatically.

### 4. Log explicit domain events

```ts
import audit from '@rikology/adonisjs-audit-trail/services/main'

await audit.log('invoice.approved').on(invoice).withMeta({ level: 2 }).commit()
```

### 5. Query the trail

```ts
import Audit from '@rikology/adonisjs-audit-trail/models/audit'

const trail = await Audit.forModel(invoice).orderBy('seq', 'desc').cursorPaginate(20)
```

### 6. Verify integrity

```bash
node ace audit:verify
```

Exit code is non-zero when a chain break is detected, so it can be wired into CI/cron.

## Documentation

- [Configuration reference](./docs/configuration.md)
- [Guarantee modes](./docs/guarantee-modes.md)
- [Tamper evidence & verification](./docs/tamper-evidence.md)
- [Redaction & GDPR](./docs/redaction-gdpr.md)
- [Retention & pruning](./docs/retention.md)
- [Multi-tenancy](./docs/multi-tenancy.md)
- [Stores](./docs/stores.md)
- [Operations guide](./docs/operations.md)
- [Recipes: Inertia audit viewer](./docs/recipes/inertia-viewer.md)
- [Recipes: SIEM shipping](./docs/recipes/siem-shipping.md)
- [Threat model](./docs/threat-model.md)
- [Upgrade policy](./docs/upgrade-policy.md)

## Benchmarks

Run locally with:

```bash
npm run bench
BENCH_DB=postgres npm run bench
```

| Metric                                 | Target           | Observed (SQLite, MBP M1 Pro)         |
| -------------------------------------- | ---------------- | ------------------------------------- |
| Enqueue overhead per `model.save()`    | < 0.2 ms p99     | ~0.075 ms p99                         |
| Flush throughput (Postgres, batch 200) | >= 5,000 events/s | run `BENCH_DB=postgres npm run bench` |

## License

[MIT](./LICENSE.md)
