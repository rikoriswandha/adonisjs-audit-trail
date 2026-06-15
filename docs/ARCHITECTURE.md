## Architecture Plan: `@rikology/adonisjs-audit-trail` — Production-Grade Audit Trail for AdonisJS v7

**Status:** Proposal / Design Document
**Target framework:** AdonisJS v7 (Node.js ≥ 24, TypeScript 5.9/6.0, ESM-only)
**Date:** June 2026

---

## 1. Executive Summary

This document specifies the architecture for a production-grade audit trail library for AdonisJS v7. The goal is to go beyond "model change history" packages and deliver a system suitable for compliance-driven environments (SOC 2, ISO 27001, HIPAA, PCI-DSS, GDPR): tamper-evident, append-only, asynchronous, PII-aware, multi-storage, and fully type-safe.

The library captures three classes of events:

1. **Model events** — create/update/delete/restore on Lucid models (automatic, via a mixin).
2. **HTTP/auth events** — logins, logouts, failed auth, permission denials, sensitive route access (via middleware + framework event listeners).
3. **Domain events** — explicit, developer-emitted business events ("invoice approved", "report exported") via a fluent API.

Core differentiators over existing community packages:

- **Append-only with tamper evidence** (per-tenant SHA-256 hash chain, optional periodic anchoring).
- **Asynchronous, batched write pipeline** with an outbox/transactional guarantee option, so auditing never blocks or breaks the request path.
- **Actor & context resolution via `AsyncLocalStorage`** — no need to thread `HttpContext` through model saves.
- **Pluggable storage drivers** (Lucid/SQL, external sink like HTTP/S3/stream) behind a manager, mirroring AdonisJS's own manager/driver patterns (hash, drive, encryption).
- **PII redaction & retention policies** as first-class config.
- **First-class v7 integration**: provider + `configure` flow, transformer for serializing audits to the frontend, generated types via `indexEntities`, OpenTelemetry spans on the write pipeline.

---

## 2. Research & Prior Art

### 2.1 Existing AdonisJS ecosystem

| Package | Approach | Gaps for production |
|---|---|---|
| `@stouder-io/adonis-auditing` (v6) | `Auditable` mixin on Lucid models, audits table, user/metadata resolvers, events. Inspired by Laravel Auditing. | Synchronous writes in the request path; no tamper evidence; single SQL store; no HTTP/domain events; not v7-native. |
| `adonis5-audit` (v5) | Mixin requiring `ctx` passed manually to `model.save({ ctx })` because ALS "didn't work properly" inside the mixin. | Manual context threading is error-prone; v5-era IoC strings; abandoned-ish. |
| Lucid core | No built-in auditing (long-standing community request, lucid#435). | — |

**Lesson:** the mixin + resolvers + audits-table shape (Laravel Auditing lineage) is the right *developer-facing* API; the missing pieces are the production pipeline behind it.

### 2.2 Production audit-log design (industry consensus)

Recurring requirements from security/compliance literature:

- **Immutability enforced at the data store**, not just in code — append-only tables, revoked UPDATE/DELETE grants, or WORM/object-lock storage for archived segments. Code-level guards alone leave a back door.
- **Tamper evidence** via hash chaining: each entry's hash covers its canonicalized payload plus the previous entry's hash; altering any record breaks every subsequent hash. Optionally sign batches and anchor periodic chain roots externally.
- **Asynchronous logging** so audit writes don't block the hot path; pair with an **outbox pattern + idempotency** to avoid losing entries on retries and to avoid dual-write divergence between entity tables and audit tables.
- **Ordering by server-assigned sequence**, not wall-clock timestamps (clock skew breaks ordering and chains).
- **Separation of duties**: services that write audits should not be able to modify them; restrict reads.
- **Plan for privacy and retention from day one**: redaction of sensitive fields, configurable retention, and a redaction strategy that doesn't break the hash chain (store hashes of redacted values, or use verifiable-redaction techniques).
- **Centralization-friendly**: structured, standardized records that can be shipped to ELK/Datadog/SIEM.

### 2.3 AdonisJS v7 platform capabilities to leverage

- **Manager/driver config pattern** (`defineConfig` + `drivers.*`), as seen in the new encryption module — our storage layer mirrors it.
- **`indexEntities()` hooks** — we ship our own init hook contribution so audit transformer types and the Audit model are indexed/generated.
- **HTTP Transformers** (`BaseTransformer`) — we ship `AuditTransformer` for type-safe serialization to Inertia/API consumers instead of `toJSON()`.
- **Built-in OpenTelemetry** — the write pipeline emits spans/metrics with zero extra dependencies.
- **`HttpRequest`/`HttpResponse`** renamed classes — middleware and macros must target the v7 names.
- **`crypto.randomUUID()`** as the framework-blessed ID approach (cuid removed) — we use UUIDv7 (Node 24 `crypto`) for sortable IDs.
- **Node 24 native features**: `AsyncLocalStorage` (stable, fast), native `glob`, `util.parseEnv` — minimal third-party deps.

---

## 3. Requirements

### 3.1 Functional

- FR1: Automatic auditing of Lucid model `created` / `updated` / `deleted` (incl. soft-delete "restored") with old/new value diffs.
- FR2: Per-model opt-in via `Auditable` mixin; per-model config (events, ignored/hidden columns, diff strategy, tags).
- FR3: Automatic actor resolution (authenticated user via `ctx.auth`), plus system/CLI/job actor fallbacks.
- FR4: Automatic context capture: request ID, IP, user agent, URL, route name, HTTP method, session ID, tenant ID.
- FR5: Explicit domain-event API: `audit.log('invoice.approved').on(invoice).by(user).withMeta({...})`.
- FR6: HTTP/auth event capture via listeners on `@adonisjs/auth` events and an optional route middleware for sensitive endpoints.
- FR7: Query API: fetch audits for a model instance, for an actor, by event type, by time range; cursor pagination.
- FR8: Restore/inspect helpers: `audit.getModified()`, `audit.diff()`, optional "revert entity to this version".
- FR9: Pluggable stores: `lucid` (default, SQL), `http` (ship to external collector), `stream` (NDJSON to file/stdout for SIEM ingestion), and a `fanout` composite.
- FR10: Tamper evidence: per-stream hash chain + `node ace audit:verify` command.
- FR11: Retention: `node ace audit:prune` honoring per-event-type retention policies, with archive-before-prune hooks (e.g., export segment to object storage).
- FR12: PII handling: field-level redaction/masking/hash-only modes; GDPR erasure support via crypto-shredding (encrypt sensitive payloads per-subject key; delete key to "erase").
- FR13: Multi-tenancy: tenant column on every record, tenant-scoped chains and queries.
- FR14: Frontend consumption: `AuditTransformer` + generated types; example Inertia viewer recipes.

### 3.2 Non-functional

- NFR1: **Zero hot-path blocking** — enqueue is in-memory O(1); flush is batched and off the request lifecycle. Target: < 0.2 ms overhead per audited model save.
- NFR2: **No lost audits** under normal operation; configurable guarantee level (see §6.3): `best-effort`, `request-coupled`, `transactional-outbox`.
- NFR3: **Crash safety**: graceful shutdown flush hook; outbox replay on boot for `transactional-outbox` mode.
- NFR4: Type safety end-to-end; no `any` in public API; generated event-name unions from user config.
- NFR5: ESM-only, Node ≥ 24, peer deps: `@adonisjs/core@^7`, `@adonisjs/lucid@^22` (optional peer for the lucid store/mixin).
- NFR6: Test coverage via Japa; tested against PostgreSQL, MySQL, SQLite; property tests for chain verification.
- NFR7: Observability: OTel spans (`audit.flush`, `audit.store.write`), counters (queued, written, dropped, retried), and a `/health`-friendly `auditTrail.stats()`.

---

## 4. High-Level Architecture

```
                ┌─────────────────────────────────────────────────────┐
                │                     Capture Layer                   │
                │                                                     │
  Lucid hooks ──┤  Auditable mixin   AuthListener   audit.log() API   │
  (created/     │        │                │               │           │
   updated/     └────────┼────────────────┼───────────────┼───────────┘
   deleted)              ▼                ▼               ▼
                ┌─────────────────────────────────────────────────────┐
                │                AuditContext (ALS)                   │
                │  actor, request meta, tenant, correlation id        │
                └────────────────────────┬────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────┐
                │                 Event Assembly                      │
                │  diff computation → redaction → canonicalization    │
                │  → AuditEvent (typed, serialized, UUIDv7 id)        │
                └────────────────────────┬────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────┐
                │              Write Pipeline (async)                 │
                │  ring-buffer queue → batcher → hash-chainer         │
                │  → guarantee strategy (best-effort / coupled /      │
                │    outbox) → retry w/ backoff → DLQ hook            │
                └────────────────────────┬────────────────────────────┘
                                         ▼
                ┌─────────────────────────────────────────────────────┐
                │               Store Manager (drivers)               │
                │   lucid (SQL)   │   http (collector)  │  stream     │
                │                 fanout (composite)                  │
                └─────────────────────────────────────────────────────┘
                                         │
                          ┌──────────────┴──────────────┐
                          ▼                             ▼
                  Query / Read API               Ops commands
                  (repository + transformer)     verify / prune / replay
```

---

## 5. Data Model

### 5.1 `audits` table (Lucid store, default)

```ts
this.schema.createTable('audits', (table) => {
  table.uuid('id').primary()                       // UUIDv7 (time-sortable)
  table.bigIncrements('seq').unique()              // server-assigned order; chain order key
  table.string('stream', 64).notNullable()         // chain partition, e.g. `tenant:{id}` or 'global'

  // What happened
  table.string('event', 128).notNullable()         // 'model.updated', 'auth.login', 'invoice.approved'
  table.string('auditable_type', 128).nullable()   // model/entity name
  table.string('auditable_id', 64).nullable()
  table.jsonb('old_values').nullable()             // redacted diff (before)
  table.jsonb('new_values').nullable()             // redacted diff (after)
  table.jsonb('metadata').nullable()               // free-form, validated size cap

  // Who did it
  table.string('actor_type', 64).nullable()        // 'user' | 'system' | 'job' | 'cli' | custom
  table.string('actor_id', 64).nullable()
  table.string('actor_label', 255).nullable()      // denormalized display name (survives user deletion)

  // Where / how
  table.string('tenant_id', 64).nullable().index()
  table.string('request_id', 64).nullable()
  table.string('correlation_id', 64).nullable()
  table.string('ip_address', 45).nullable()
  table.string('user_agent', 512).nullable()
  table.string('url', 2048).nullable()
  table.string('http_method', 10).nullable()

  // Integrity
  table.string('hash', 64).notNullable()           // sha256(canonical(entry) + prev_hash)
  table.string('prev_hash', 64).notNullable()      // '0'.repeat(64) for genesis per stream
  table.string('schema_version', 8).notNullable().defaultTo('1')

  table.timestamp('created_at', { useTz: true }).notNullable()

  table.index(['auditable_type', 'auditable_id', 'seq'])
  table.index(['actor_type', 'actor_id', 'seq'])
  table.index(['event', 'created_at'])
  table.index(['stream', 'seq'])
})
```

**Immutability enforcement (DB level):**
- Migration optionally (config flag) creates a `BEFORE UPDATE OR DELETE` trigger raising an exception (Postgres/MySQL), so even raw SQL can't mutate rows.
- Documentation prescribes a dedicated DB role: app role gets `INSERT, SELECT` only on `audits`; pruning runs under a separate maintenance role. Code-level guards (model `beforeUpdate` throw) are a convenience, not the boundary.

### 5.2 `audit_outbox` table (only for `transactional-outbox` mode)

`id (auto-increment)`, `payload (jsonb)`, `attempts`, `claimed_at`, `processed_at`, `created_at`, `updated_at`. Rows are written inside the *same DB transaction* as the business change, then drained by the pipeline and moved into `audits` (where chaining happens). Survives process crashes.

### 5.3 Canonical serialization (chain input)

Hash chains die on serialization ambiguity. We define `canonical(entry)`:
- JSON with lexicographically sorted keys, no whitespace.
- All timestamps as ISO-8601 UTC with millisecond precision.
- Numbers serialized via a fixed decimal canonicalizer; `undefined` stripped; `null` preserved.
- Fields included in the hash: `id, seq, stream, event, auditable_type, auditable_id, old_values, new_values, metadata, actor_type, actor_id, tenant_id, created_at, schema_version, prev_hash`.
- Mutable/operational fields (`actor_label`) are excluded so denormalized display data can be backfilled without breaking the chain — documented explicitly.

`hash = sha256(canonical(entry))`, hex-encoded. Genesis `prev_hash` per stream is 64 zeros.

---

## 6. Component Design

### 6.1 Package layout

```
@rikology/adonisjs-audit-trail/
├── package.json                  # exports map, peer deps, ESM only
├── configure.ts                  # node ace configure entrypoint
├── stubs/
│   ├── config/audit.stub
│   ├── migrations/create_audits_table.stub
│   ├── migrations/create_audit_outbox_table.stub
│   └── transformers/audit_transformer.stub
├── providers/audit_provider.ts
├── src/
│   ├── define_config.ts
│   ├── types.ts                  # AuditEvent, AuditableConfig, StoreContract, GuaranteeMode...
│   ├── audit_context.ts          # ALS wrapper
│   ├── middleware/audit_context_middleware.ts
│   ├── mixins/auditable.ts
│   ├── listeners/auth_listener.ts
│   ├── core/
│   │   ├── assembler.ts          # diff, redact, canonicalize → AuditEvent
│   │   ├── redactor.ts
│   │   ├── canonical_json.ts
│   │   ├── hash_chain.ts
│   │   ├── pipeline.ts           # queue, batcher, flusher, retry, shutdown hook
│   │   └── guarantees/{best_effort,request_coupled,outbox}.ts
│   ├── stores/
│   │   ├── store_manager.ts
│   │   ├── lucid_store.ts
│   │   ├── http_store.ts
│   │   ├── stream_store.ts
│   │   └── fanout_store.ts
│   ├── models/audit.ts           # read-only Lucid model
│   ├── repository/audit_repository.ts
│   └── services/audit.ts         # `audit` facade (log/withinContext/stats)
├── commands/
│   ├── audit_verify.ts
│   ├── audit_prune.ts
│   └── audit_replay_outbox.ts
└── tests/
```

`package.json` exports: `.` (service + types), `./auditable` (mixin), `./audit_provider`, `./services/main`, `./types`.

### 6.2 Context propagation — `AuditContext` (ALS)

The v5-era package required passing `ctx` into `model.save()` because ALS misbehaved inside mixins; on Node 24 / v7 this is solved cleanly:

- `AuditContextMiddleware` (registered in the router middleware stack during `configure`) runs `als.run(store, next)` per request, capturing `request.id()`, IP, UA, URL, route, and a lazy actor resolver bound to `ctx.auth`.
- Actor is resolved **lazily at event-assembly time** (auth may complete after the middleware runs).
- Outside HTTP (jobs, ace commands), `audit.withinContext({ actor: systemActor('cron'), tenantId }, fn)` establishes scope; otherwise events fall back to `actor_type: 'system'` with the process/command name.
- The user resolver and metadata resolvers are configurable (same resolver concept as the v6 community package, but ALS-backed instead of manual threading).

### 6.3 Write pipeline & delivery guarantees

The pipeline is a singleton bound in the container by the provider.

**Queue → batch → chain → write:**
1. `enqueue(event)` pushes to a bounded in-memory ring buffer (default 10k). On overflow: configurable `dropOldest | dropNew | blockWithTimeout` + a `audit:dropped` framework event for alerting.
2. A flusher drains on `maxBatchSize` (default 200) or `flushIntervalMs` (default 250 ms).
3. **Chaining happens at write time, inside the store, under a per-stream advisory lock / serialized insert** (Postgres: `pg_advisory_xact_lock(hash(stream))`; MySQL: `GET_LOCK`; SQLite: single-writer anyway). This guarantees `seq`/`prev_hash` correctness under multi-instance deployments without coordinating in app memory.
4. Retry with exponential backoff + jitter (default 5 attempts), then a dead-letter hook (`onDeadLetter(events)`) — default implementation NDJSON-dumps to `storage/audit-dlq/`.

**Guarantee modes (per-config, with per-call override):**

| Mode | Behavior | Use when |
|---|---|---|
| `best-effort` (default) | Enqueue and return immediately; flush async. Graceful-shutdown hook flushes the buffer (v7 note: shutdown hooks run in reverse registration order — provider registers ours early so it flushes last). | High-volume, non-regulated events |
| `request-coupled` | Response is held until the events from this request are flushed (await with timeout). | Moderate assurance without schema changes |
| `transactional-outbox` | Audit rows written to `audit_outbox` in the *same transaction* as the model change (Lucid `$trx` detection in the mixin); drainer moves them into `audits`. Atomic with business data; crash-safe. | Regulated/financial flows |

The mixin auto-detects an active transaction on the model and, in outbox mode, joins it — eliminating the classic dual-write divergence.

### 6.4 `Auditable` mixin (Lucid)

```ts
import { compose } from '@adonisjs/core/helpers'
import { BaseModel } from '@adonisjs/lucid/orm'
import { Auditable } from '@rikology/adonisjs-audit-trail/auditable'

export default class Invoice extends compose(BaseModel, Auditable) {
  static auditConfig = {
    events: ['created', 'updated', 'deleted'],
    exclude: ['updatedAt'],            // never diffed
    redact: ['iban'],                  // diffed as '[REDACTED]', hash stored for comparability
    tags: ['billing'],
    strict: false,                     // true → throw if audit enqueue fails
  }
}
```

Implementation: registers `afterCreate`, `afterUpdate`, `afterDelete` (and `afterRestore` if soft-deletes detected) hooks once per class. Diff uses Lucid's `$dirty`/`$original` for updates; full snapshot for create/delete (configurable `snapshot: 'diff' | 'full'`). `$extras`/computed props excluded by default.

### 6.5 Domain-event facade

```ts
import audit from '@rikology/adonisjs-audit-trail/services/main'

await audit
  .log('invoice.approved')        // typed union if user registers event names in config
  .on(invoice)                    // or .onRef('Invoice', id)
  .withMeta({ approvalLevel: 2 })
  .tag('billing')
  .commit()                       // or .commitSync() to force request-coupled for this event
```

Event-name typing: users may declare `events: ['invoice.approved', ...] as const` in `config/audit.ts`; we use module augmentation (`AuditEvents` interface) so `audit.log()` autocompletes — same pattern AdonisJS uses for typed events/routes.

### 6.6 Store drivers

`defineConfig` mirrors v7 manager patterns:

```ts
// config/audit.ts
import { defineConfig, stores } from '@rikology/adonisjs-audit-trail'

export default defineConfig({
  default: 'lucid',
  guarantee: 'best-effort',
  stores: {
    lucid: stores.lucid({ connection: 'audit', table: 'audits', enforceImmutability: true }),
    siem: stores.stream({ destination: 'stdout', format: 'ndjson' }),
    all: stores.fanout({ primary: 'lucid', mirrors: ['siem'], mirrorFailure: 'log' }),
  },
  redaction: {
    global: ['password', 'token', '*.secret'],
    mode: 'mask',                       // 'mask' | 'remove' | 'hash'
  },
  retention: {
    default: '730 days',
    perEvent: { 'auth.login': '90 days' },
    archive: async (segment) => { /* push NDJSON to object storage w/ object lock */ },
  },
  chain: { enabled: true, streamBy: 'tenant' },   // 'tenant' | 'global' | (event) => string
  queue: { maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' },
})
```

`StoreContract`: `write(batch, chainCtx)`, `head(stream)`, `verify(stream, range)`, `prune(policy)`, optional `query(...)`. The `http` store signs batches (HMAC) and supports the collector returning the new chain head, enabling chained external sinks.

### 6.7 Read side

- **`Audit` Lucid model**: read-only (throws on `save`/`delete`), pre-scoped query helpers: `Audit.forModel(invoice)`, `.byActor(user)`, `.inTenant(id)`, `.between(a, b)`, cursor pagination on `seq`.
- **Mixin accessors**: `invoice.audits()` relation-like query, `invoice.lastAudit()`.
- **`AuditTransformer`** (v7 `BaseTransformer`) shipped as a stub so apps get typed serialization to Inertia/React or JSON APIs out of the box, with `actor_label` and a humanized diff shape.

### 6.8 Integrity verification & redaction interplay

- `node ace audit:verify [--stream=…] [--from-seq --to-seq] [--repair-report=path]` — walks each stream in `seq` order, recomputes canonical hashes, reports first break + all subsequent invalidated ranges. Exit code non-zero on failure (CI/cron friendly). Verification only needs `SELECT`.
- Optional **anchoring**: every N entries (or daily), emit the chain head to a configured anchor (append to an external log, write to object-lock storage, POST to a notary endpoint). Detects whole-suffix truncation, which a bare hash chain cannot.
- **GDPR erasure without chain breakage**: sensitive payload fields can be stored encrypted with a per-data-subject key (using v7 `EncryptionManager` with a dedicated key list); "erasure" = delete the subject's key (crypto-shredding). The ciphertext (which was what got hashed) remains intact, so the chain still verifies. `redact: 'hash'` mode is the lighter alternative: only `sha256(value + salt)` ever enters the record.

### 6.9 HTTP & auth capture

- `AuthListener` subscribes to `@adonisjs/auth` emitter events (`session_auth:login_succeeded`, `login_failed`, `logout`, access-token equivalents) → `auth.*` audit events with actor + IP/UA from ALS.
- Optional named middleware `auditRoute('document.downloaded')` for sensitive endpoints — records access events including permission-denied outcomes (record denials, not just successes).

### 6.10 Ops & lifecycle

- **Provider** (`audit_provider.ts`): `register()` binds config/manager/pipeline; `boot()` wires Lucid hooks helper + auth listener; `start()` starts the flusher and (if outbox) the drainer + boot-time replay; `shutdown()` final flush with deadline.
- **Commands**: `audit:verify`, `audit:prune` (archive hook → delete under maintenance connection, oldest segments first, never the chain head), `audit:replay-outbox`, `audit:stats`.
- **Observability**: every flush wrapped in an OTel span (v7 zero-config OTel), metrics surfaced via `audit.stats()` and emitter events (`audit:flushed`, `audit:dropped`, `audit:dead_letter`).

---

## 7. configure flow (`node ace configure @rikology/adonisjs-audit-trail`)

1. Publish `config/audit.ts` stub.
2. Publish migration(s): `create_audits_table` (+ outbox if selected via prompt), with the immutability trigger guarded by a config flag.
3. Register provider in `adonisrc.ts`.
4. Register `AuditContextMiddleware` in `start/kernel.ts` (router middleware).
5. Publish `app/transformers/audit_transformer.ts` stub.
6. Add `AUDIT_*` env vars to `.env.example` + `start/env.ts` validation.
7. Print post-install notes: DB role hardening, `streamBy` choice, guarantee mode guidance.

Prompts: store choice, outbox mode (y/n), chain enabled (y/n), multi-tenant (y/n).

---

## 8. Performance & Scaling Notes

- **Hot path cost** = diff (on already-loaded `$dirty`) + redaction + ring-buffer push. Hashing/canonicalization happen in the flusher, off the request.
- **Insert throughput**: batched multi-row inserts; per-stream serialization only contends within a stream — `streamBy: 'tenant'` makes contention proportional to per-tenant write rates, not global.
- **Table growth**: monthly **partitioning recipe** for Postgres documented (chain verification works per-stream across partitions because order is `seq`); pruning drops whole partitions where possible.
- **Read isolation**: support a dedicated `connection: 'audit'` so audit I/O can live on a separate database/replica.
- **JSONB diffs**: cap `metadata`/diff payload size (default 32 KB, configurable) with overflow stored as a truncation marker + hash of full payload.

## 9. Security Model Summary

| Threat | Mitigation |
|---|---|
| App-level row tampering | Read-only model + DB trigger + INSERT-only grant |
| DBA/attacker edits rows | Hash chain breaks; `audit:verify` detects |
| Suffix truncation (delete newest rows) | Periodic external anchoring of chain head |
| Lost events on crash | Shutdown flush; outbox mode for atomicity |
| Audit of audit access | Repository reads can themselves emit `audit.viewed` events (opt-in) |
| PII leakage in trails | Field redaction modes; crypto-shredding for erasure |
| Clock skew breaking order | `seq` is the order key; timestamps informational |

## 10. Testing Strategy

- **Unit (Japa)**: canonical JSON determinism (property-based: random objects → stable hash), redactor paths/wildcards, diff engine vs. Lucid `$dirty` edge cases (DateTime, JSON columns, null↔undefined).
- **Integration**: mixin against SQLite/Postgres/MySQL in CI matrix; transaction-join behavior in outbox mode (rollback ⇒ no audit); multi-instance chain correctness via two concurrent writers against Postgres advisory locks.
- **Failure injection**: store throwing mid-batch ⇒ retry/DLQ; overflow policies; shutdown-during-flush.
- **Verification**: mutate a row in test DB ⇒ `audit:verify` flags exactly the right range.
- **Bench**: tinybench suite for enqueue overhead and flush throughput; published in README.

## 11. Delivery Roadmap

| Phase | Scope | Outcome |
|---|---|---|
| **0.x (4–5 wks)** | Core types, ALS context, mixin, lucid store, best-effort pipeline, basic query API, configure flow | Usable model auditing, v7-native |
| **1.0 (3–4 wks)** | Hash chain + verify command, redaction, domain-event facade, auth listener, prune/retention, transformer stub | Production baseline |
| **1.x** | Outbox mode, http/stream/fanout stores, anchoring, crypto-shredding, partitioning docs, Inertia viewer recipe | Compliance-grade |
| **2.x** | Diff-viewer UI package, revert-to-version, search store (OpenSearch driver), per-event sampling | Ecosystem polish |

## 12. Open Questions / Decisions to Confirm

1. **Default `streamBy`** — `global` is simpler; `tenant` scales better. Proposal: `global` unless multi-tenant prompt answered yes.
2. **Should `request-coupled` be the default for `deleted` events?** They're rare and high-value; leaning yes.
3. **Hash chain on the `http` store** — chain locally before shipping vs. let the collector chain? Proposal: local chaining always; collector chaining optional.
4. **License & name** — `@rikology/adonisjs-audit-trail`; MIT recommended for ecosystem adoption.

---

### Appendix A — Minimal end-to-end example

```ts
// app/models/document.ts
export default class Document extends compose(BaseModel, Auditable) {
  static auditConfig = { redact: ['content'], tags: ['dms'] }
}

// app/controllers/documents_controller.ts
async destroy({ params, response }: HttpContext) {
  const doc = await Document.findOrFail(params.id)
  await doc.delete()               // audit captured automatically with actor/IP via ALS
  await audit.log('document.purge_requested').on(doc).commitSync()
  return response.noContent()
}

// later
const trail = await Audit.forModel(doc).orderBy('seq', 'desc').cursorPaginate(20)
```
