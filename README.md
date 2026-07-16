# `@rikology/adonisjs-audit-trail`

[![checks](https://github.com/rikoriswandha/adonisjs-audit-trail/actions/workflows/checks.yml/badge.svg)](https://github.com/rikoriswandha/adonisjs-audit-trail/actions/workflows/checks.yml)
[![npm version](https://img.shields.io/npm/v/@rikology/adonisjs-audit-trail)](https://www.npmjs.com/package/@rikology/adonisjs-audit-trail)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

Production-grade, tamper-evident audit trail for [AdonisJS v7](https://adonisjs.com).

Capture who changed what, when, and from where — automatically for Lucid models and explicitly for domain events — into an append-only, hash-chained trail you can cryptographically verify. Built for compliance workloads (SOC 2, GDPR, HIPAA-style) where the audit log itself must be trustworthy.

## Why this package?

Most AdonisJS auditing solutions stop at "who changed this row". `@rikology/adonisjs-audit-trail` is designed for environments where **the log is evidence**:

- **Tamper-evident by default** — every record is linked into a per-stream SHA-256 hash chain; modification breaks every successor.
- **Guarantee-aware delivery** — best-effort delivery is asynchronous; request-coupled waits for a flush; transactional outbox durably records source intent in the caller-owned business transaction before asynchronous delivery.
- **Pluggable storage** — SQL, NDJSON stream, HTTP collector, or fanout.
- **Compliance-aware** — field-level redaction, retention policies, GDPR crypto-shredding, multi-tenancy.
- **Native v7 integration** — provider, configure flow, middleware, transformer stub, and Ace commands.

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Features](#features)
- [Documentation](#documentation)
- [Demo app](#demo-app)
- [Benchmarks](#benchmarks)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Requirements

- Node.js `>= 24`
- AdonisJS v7 (`@adonisjs/core@^7`)
- TypeScript 5.9+

## Quick start

### 1. Install

```bash
node ace add @rikology/adonisjs-audit-trail
```

Or with your package manager of choice:

```bash
npm install @rikology/adonisjs-audit-trail
pnpm add @rikology/adonisjs-audit-trail
yarn add @rikology/adonisjs-audit-trail
```

The `configure` command publishes `config/audit.ts`, migrations, the audit transformer, and registers the provider, commands, and middleware.

For CI or other non-interactive environments, pass flags to skip the prompts:

```bash
node ace configure @rikology/adonisjs-audit-trail --outbox --no-multi-tenant --immutability
```

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

### Auth event capture and transactional outbox

Auth emitter capture (`captureAuthEvents`) remains enabled by default for `best-effort` and `request-coupled` delivery. It defaults to disabled for `transactional-outbox`, and setting it to `true` in that mode is rejected: framework emitter payloads do not carry the caller-owned business transaction that fail-closed outbox submission requires.

When an auth-related audit intent must commit atomically with business state, record it explicitly at that operation's transaction boundary:

```ts
await db.transaction(async (trx) => {
  // Make the auth-related business-state change with trx.
  await audit.log('auth.login').withTransaction(trx).commit()
})
```

This writes the durable source intent in `trx`; the outbox drainer still delivers the final audit record asynchronously.

### 5. Query the trail

```ts
import Audit from '@rikology/adonisjs-audit-trail/models/audit'

const trail = await Audit.query()
  .apply((scopes) => scopes.forModel(invoice))
  .orderBy('seq', 'desc')
```

### 6. Verify integrity

```bash
node ace audit:verify
```

Exit code is non-zero when a chain break is detected, so it can be wired into CI/cron.

## Features

- **Automatic** model auditing via a Lucid mixin.
- **Explicit** domain events via a fluent API.
- **Tamper-evident** SHA-256 hash chains with `node ace audit:verify`.
- **Guarantee-aware delivery** — best-effort writes are asynchronous, request-coupled writes await a flush, and transactional outbox commits source intent with the caller-owned business transaction before asynchronous delivery.
- **Three delivery guarantees**: `best-effort`, `request-coupled`, and `transactional-outbox`.
- **Pluggable stores**: SQL (Lucid), NDJSON stream, HTTP collector, or fanout.
- **PII-aware** redaction, masking, hashing, and crypto-shredding support.
- **Multi-tenancy** with tenant-scoped chains and queries.
- **Type-safe** end-to-end with generated event-name unions and v7 transformers.

## Documentation

- [Configuration reference](./docs/configuration.md) — every config option, env variable, and typed event names.
- [Guarantee modes](./docs/guarantee-modes.md) — choosing between best-effort, request-coupled, and transactional-outbox.
- [Tamper evidence & verification](./docs/tamper-evidence.md) — how the hash chain works and what to do if verification fails.
- [Redaction & GDPR](./docs/redaction-gdpr.md) — masking, hashing, and crypto-shredding sensitive fields.
- [Retention & pruning](./docs/retention.md) — archive and prune old events safely.
- [Multi-tenancy](./docs/multi-tenancy.md) — tenant-scoped streams and queries.
- [Stores](./docs/stores.md) — built-in storage drivers and custom store authoring.
- [Operations guide](./docs/operations.md) — partitioning, role grants, DLQ monitoring, and cron verification.
- [Recipes: Inertia audit viewer](./docs/recipes/inertia-viewer.md)
- [Recipes: SIEM shipping](./docs/recipes/siem-shipping.md)
- [Threat model](./docs/threat-model.md)
- [Upgrade policy](./docs/upgrade-policy.md)
- [Architecture](./docs/ARCHITECTURE.md) — design rationale and prior-art analysis.

## Demo app

See [`examples/demo`](./examples/demo) for a runnable AdonisJS v7 API that shows the Lucid mixin, request context middleware, explicit domain events, redaction, and `audit:verify`.

## Benchmarks

Run locally with:

```bash
npm run bench
BENCH_DB=postgres npm run bench
```

| Metric                                 | Target            | Observed (SQLite, MBP M1 Pro)         |
| -------------------------------------- | ----------------- | ------------------------------------- |
| Enqueue overhead per `model.save()`    | < 0.2 ms p99      | ~0.075 ms p99                         |
| Flush throughput (Postgres, batch 200) | >= 5,000 events/s | run `BENCH_DB=postgres npm run bench` |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the development workflow, and conventions. Please also read the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

If you discover a security vulnerability, please **do not open a public issue**. Follow the disclosure process in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE.md) © Rikology
