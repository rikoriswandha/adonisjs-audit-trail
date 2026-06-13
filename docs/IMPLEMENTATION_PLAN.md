## Implementation Plan: `@rikology/adonisjs-audit-trail` for AdonisJS v7

**Type:** Ready-to-execute implementation plan
**Base:** [`adonisjs/pkg-starter-kit`](https://github.com/adonisjs/pkg-starter-kit) (v7 edition: Node ≥ 24, ESM, tsdown, Japa, release-it)
**Companion doc:** `ARCHITECTURE.md` (architecture & rationale)
**Estimated effort:** ~9 weeks solo / ~5 weeks with 2 devs

This plan is ordered so that **every milestone ends with a green test suite and a publishable package**. Each task lists exact files, key code skeletons, and acceptance criteria. Check boxes as you go.

---

## Conventions used in this plan

- Package name placeholder: `@rikology/adonisjs-audit-trail` (npm) / import alias `@rikology/adonisjs-audit-trail`. Rename globally before M0 ends.
- File naming: `snake_case` (enforced by `@adonisjs/eslint-config`).
- All source is ESM TypeScript under `src/`; nothing in `src/` imports from `providers/` (one-way dependency).
- "AC" = acceptance criteria for the task.

---

# Milestone 0 — Scaffold & Toolchain (Day 1–2)

### T0.1 Scaffold from starter kit

```bash
npx giget@latest gh:adonisjs/pkg-starter-kit adonisjs-audit-trail
cd adonisjs-audit-trail
git init && git add -A && git commit -m "chore: scaffold from pkg-starter-kit"
npm install
```

The starter ships with (do not re-create these):

```
├── .github/workflows/{checks.yml, release.yml}
├── bin/test.ts                # Japa entrypoint (runs via @poppinss/ts-exec)
├── configure.ts               # empty configure hook
├── index.ts                   # exports { configure, stubsRoot }
├── providers/  src/  stubs/  tests/
├── eslint.config.js  tsconfig.json  package.json
```

Toolchain facts to respect (from the starter's `package.json`):
- `compile` = `tsdown && tsc --emitDeclarationOnly --declaration`; `postcompile` copies `stubs/**/*.stub` into `build/`.
- Tests run uncompiled: `node --import=@poppinss/ts-exec bin/test.ts`; `test` wraps with `c8` coverage and ESLint via `pretest`.
- Publishing via `release-it` + conventional changelog; `files: ["build", "!build/bin", "!build/tests"]`.
- Peer deps: `@adonisjs/core@^7`, optional `@adonisjs/assembler@^8`.

### T0.2 Package identity & exports

Edit `package.json`:

```jsonc
{
  "name": "@rikology/adonisjs-audit-trail",
  "description": "Production-grade, tamper-evident audit trail for AdonisJS v7",
  "keywords": ["adonisjs", "audit", "audit-trail", "lucid", "compliance", "tamper-evident"],
  "exports": {
    ".": "./build/index.js",
    "./types": "./build/src/types.js",
    "./auditable": "./build/src/mixins/auditable.js",
    "./audit_provider": "./build/providers/audit_provider.js",
    "./services/main": "./build/services/main.js",
    "./stores": "./build/src/stores/main.js",
    "./commands": "./build/commands/main.js",
    "./audit_context_middleware": "./build/src/middleware/audit_context_middleware.js",
    "./models/audit": "./build/src/models/audit.js"
  },
  "tsdown": {
    "entry": [
      "./index.ts", "./configure.ts",
      "./providers/audit_provider.ts",
      "./services/main.ts",
      "./src/types.ts",
      "./src/mixins/auditable.ts",
      "./src/stores/main.ts",
      "./src/middleware/audit_context_middleware.ts",
      "./src/models/audit.ts",
      "./commands/main.ts", "./commands/audit_verify.ts",
      "./commands/audit_prune.ts", "./commands/audit_replay_outbox.ts",
      "./commands/audit_stats.ts"
    ]
    // keep the rest of starter's tsdown config (esm, outDir build, dce-only)
  }
}
```

### T0.3 Dev/peer dependencies

```bash
# runtime-adjacent peers (installed in the host app)
npm i -D @adonisjs/lucid @adonisjs/auth luxon @types/luxon

# test infra
npm i -D better-sqlite3 pg mysql2 @japa/expect-type @japa/file-system testcontainers
```

Add to `package.json`:

```jsonc
"peerDependencies": {
  "@adonisjs/core": "^7.0.0",
  "@adonisjs/assembler": "^8.0.0",
  "@adonisjs/lucid": "^22.0.0",
  "@adonisjs/auth": "^10.0.0",
  "luxon": "^3.0.0"
},
"peerDependenciesMeta": {
  "@adonisjs/assembler": { "optional": true },
  "@adonisjs/auth": { "optional": true },
  "@adonisjs/lucid": { "optional": true }   // optional: only required for the lucid store + mixin
}
```

> Rule of thumb from the starter docs: anything the host app also installs is a **peer** dep, never a direct dep.

### T0.4 Test harness for an in-memory AdonisJS app

Create `tests/helpers/app.ts` — boots an `IgnitorFactory`-based app with Lucid on SQLite (`:memory:` or tmp file) so the mixin/provider can be tested realistically:

```ts
import { IgnitorFactory } from '@adonisjs/core/factories'
import { defineConfig as defineLucid } from '@adonisjs/lucid'

export async function createTestApp(auditConfig?: Partial<AuditConfig>) {
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .withCoreProviders()
    .merge({
      rcFileContents: {
        providers: [
          () => import('@adonisjs/lucid/database_provider'),
          () => import('../../providers/audit_provider.ts'),
        ],
      },
      config: {
        database: defineLucid({ connection: 'sqlite', connections: { /* better-sqlite3 */ } }),
        audit: defineConfig({ /* test defaults, flushIntervalMs: 5 */ ...auditConfig }),
      },
    })
    .create(new URL('./tmp/', import.meta.url))
  const app = ignitor.createApp('web')
  await app.init(); await app.boot(); await app.start(() => {})
  return app
}
```

Also create `tests/helpers/migrate.ts` (runs the audits/outbox schema against the test connection) and `tests/helpers/models.ts` (a `Post` model using the mixin).

**AC (M0):** `npm run test` green with one smoke test (`app boots, container resolves 'audit.manager'` — stub binding for now); `npm run compile` produces `build/` with all entrypoints + copied stubs; `npm run typecheck` clean. Commit + tag `v0.0.1-alpha.0` (no publish).

---

# Milestone 1 — Types, Config & Canonical Core (Week 1)

### T1.1 `src/types.ts` — the public contract (write first)

Define and export:

```ts
export type ActorType = 'user' | 'system' | 'job' | 'cli' | (string & {})
export interface AuditActor { type: ActorType; id: string | null; label?: string | null }

export interface AuditEvent {
  id: string                      // UUIDv7
  event: string
  stream: string
  auditableType: string | null
  auditableId: string | null
  oldValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  actor: AuditActor
  tenantId: string | null
  requestId: string | null
  correlationId: string | null
  ipAddress: string | null
  userAgent: string | null
  url: string | null
  httpMethod: string | null
  tags: string[]
  schemaVersion: '1'
  createdAt: string               // ISO-8601 UTC ms
}

export interface ChainedAuditEvent extends AuditEvent { seq: number; hash: string; prevHash: string }

export interface AuditStoreContract {
  write(batch: AuditEvent[]): Promise<ChainedAuditEvent[]>
  head(stream: string): Promise<{ seq: number; hash: string } | null>
  verify(stream: string, range?: { fromSeq?: number; toSeq?: number }): AsyncIterable<VerifyReport>
  prune(policy: ResolvedRetentionPolicy): Promise<PruneReport>
  query?(filters: AuditQueryFilters): Promise<ChainedAuditEvent[]>
}

export type GuaranteeMode = 'best-effort' | 'request-coupled' | 'transactional-outbox'
export type OverflowStrategy = 'dropOldest' | 'dropNew' | 'block'
export type RedactionMode = 'mask' | 'remove' | 'hash'

export interface AuditEvents {}    // module-augmentation point for typed event names
export type KnownAuditEvent = keyof AuditEvents extends never ? string : keyof AuditEvents

// + AuditConfig, ResolvedAuditConfig, AuditableModelConfig, RetentionPolicy,
//   AuditQueryFilters, VerifyReport, PruneReport, PipelineStats
```

### T1.2 `src/define_config.ts` + `src/stores/main.ts` (config DSL)

Mirror v7's manager pattern (like `@adonisjs/core/encryption`):

```ts
export function defineConfig<T extends Record<string, AuditStoreFactory>>(config: AuditConfig<T>) {
  return configProvider.create(async (app) => {
    /* resolve store factories with app, normalize defaults, validate */
  })
}
export const stores = {
  lucid: (opts: LucidStoreOptions) => /* factory */,
  stream: (opts: StreamStoreOptions) => /* factory */,
  http: (opts: HttpStoreOptions) => /* factory */,
  fanout: (opts: FanoutOptions) => /* factory */,
}
```

Defaults: `default: 'lucid'`, `guarantee: 'best-effort'`, `chain: { enabled: true, streamBy: 'global' }`, `queue: { maxBatchSize: 200, flushIntervalMs: 250, capacity: 10_000, overflow: 'dropOldest' }`, `payloadMaxBytes: 32_768`.

### T1.3 `src/core/canonical_json.ts`

Deterministic serializer — the single most correctness-critical file:

- Lexicographic key sort (recursive), no whitespace.
- Strip `undefined`; keep `null`; reject functions/symbols/bigint with a typed error.
- Dates already normalized to ISO strings upstream; assert string here.
- Unicode: serialize as-is (JSON.stringify escaping is deterministic in V8; document that verification must use this library).

### T1.4 `src/core/hash_chain.ts`

```ts
export const GENESIS = '0'.repeat(64)
export function hashEntry(entry: AuditEvent & { seq: number; prevHash: string }): string {
  const canonical = canonicalJson(pickHashedFields(entry))
  return createHash('sha256').update(canonical).digest('hex')
}
export function chainBatch(batch: AuditEvent[], head: { seq; hash } | null): ChainedAuditEvent[]
export async function* verifyChain(rows: AsyncIterable<ChainedAuditEvent>): AsyncIterable<VerifyReport>
```

`pickHashedFields` includes exactly: `id, seq, stream, event, auditableType, auditableId, oldValues, newValues, metadata, actor.type, actor.id, tenantId, schemaVersion, createdAt, prevHash` — **excludes** `actor.label`, `tags`, transport fields. Freeze this list; changing it is `schemaVersion: '2'`.

### T1.5 `src/core/redactor.ts`

- Path matching: exact key, `*.secret` deep wildcard, `card.*` prefix — implement with a compiled matcher (no regex on user input).
- Modes: `mask` → `'[REDACTED]'`; `remove` → key dropped; `hash` → `sha256(salt + value)` hex prefixed `'sha256:'` (salt from config/env, required when mode is `hash`).
- Applies to `oldValues`, `newValues`, `metadata` before hashing/enqueue (redaction is pre-chain, by design).

### T1.6 `src/core/assembler.ts`

Builds `AuditEvent` from raw input + `AuditContext` snapshot: UUIDv7 via `crypto.randomUUID` ordering shim (or `uuidv7` from `crypto` on Node 24 — verify at impl time; otherwise vendor a 30-line UUIDv7 generator, no dependency), ISO timestamps, payload size cap (truncate + `{ _truncated: true, _sha256 }` marker), stream resolution (`streamBy`).

**Tests (write alongside):**
- `tests/unit/canonical_json.spec.ts` — property test: 1k random nested objects → `canonicalJson(a) === canonicalJson(structuredClone(a))`; key-order invariance; undefined/null matrix.
- `tests/unit/hash_chain.spec.ts` — chain → mutate any field of any row → `verifyChain` flags that row and all successors; genesis handling; cross-check one vector hashed by `sha256sum` in CI.
- `tests/unit/redactor.spec.ts` — wildcard paths, all 3 modes, non-string values, hash-mode salt requirement.
- `tests/unit/define_config.spec.ts` + `@japa/expect-type` assertions on the public types.

**AC (M1):** all above green; coverage ≥ 90% on `src/core/*`; no `any` in `src/types.ts` (`eslint @typescript-eslint/no-explicit-any: error` scoped to `src/`).

---

# Milestone 2 — Context, Pipeline & Lucid Store (Week 2–3)

### T2.1 `src/audit_context.ts` (AsyncLocalStorage)

```ts
class AuditContext {
  #als = new AsyncLocalStorage<AuditContextStore>()
  run<T>(store: AuditContextStore, fn: () => T): T
  get(): AuditContextStore | undefined
  set(patch: Partial<AuditContextStore>): void          // e.g. late actor resolution
}
export interface AuditContextStore {
  actor?: AuditActor | (() => Promise<AuditActor | null>)  // lazy resolver supported
  tenantId?: string; requestId?: string; correlationId?: string
  ip?: string; userAgent?: string; url?: string; httpMethod?: string
}
```

Fallback chain at assembly time: explicit `.by()` → ALS actor (resolve if lazy) → `{ type: app.getEnvironment() === 'console' ? 'cli' : 'system', id: null }`.

### T2.2 `src/middleware/audit_context_middleware.ts`

```ts
export default class AuditContextMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    return auditContext.run({
      requestId: ctx.request.id(),
      ip: ctx.request.ip(),
      userAgent: ctx.request.header('user-agent')?.slice(0, 512),
      url: ctx.request.url(true).slice(0, 2048),
      httpMethod: ctx.request.method(),
      actor: async () => resolveActorFromAuth(ctx),   // lazy — auth runs later
      tenantId: await config.tenantResolver?.(ctx) ?? null,
    }, next)
  }
}
```

Note v7: if augmenting request, target `HttpRequest` (renamed from `Request`).

### T2.3 `src/core/pipeline.ts`

Single class, container singleton:

- Bounded ring buffer (preallocated array, head/tail indices) with `enqueue(event): boolean`.
- Flusher: `setInterval(flushIntervalMs).unref()` + size trigger; serializes flushes (no concurrent flush).
- Per-flush: group by store routing → `store.write(batch)` → emit `audit:flushed`.
- Retry: 5 attempts, `2^n * 100ms` + jitter; on exhaustion → `onDeadLetter` hook (default NDJSON append to `app.makePath('storage/audit-dlq')`) + `audit:dead_letter` event.
- Overflow: per config; always emit `audit:dropped` with count.
- `stats(): PipelineStats` (queued, written, dropped, retried, deadLettered, lastFlushAt).
- `requestCoupledFlush(eventIds, timeoutMs)`: promise resolved by flusher bookkeeping — used by `commitSync()` and `guarantee: 'request-coupled'`.
- `shutdown(deadlineMs = 5000)`: stop timer, drain loop until empty or deadline; called from provider.

### T2.4 `src/stores/lucid_store.ts`

- `write(batch)`: group by `stream`; per stream, inside one transaction:
  - Postgres: `SELECT pg_advisory_xact_lock(hashtext(?))`; MySQL: `GET_LOCK(?, 5)` / `RELEASE_LOCK`; SQLite: no-op (single writer).
  - Read head (`MAX(seq)` row for stream), `chainBatch`, multi-row insert.
- `head`, `verify` (keyset-paginated `AsyncIterable` over `seq`), `prune` (delete below retention cutoff per event type, never the per-stream head row), `query`.
- Dialect detection from the Lucid connection client.

### T2.5 Migration + outbox stubs (used by configure in M4, but write now for tests)

`stubs/migrations/create_audits_table.stub` — schema exactly as architecture §5.1, plus mustache flags `{{#enforceImmutability}}` emitting the Postgres/MySQL `BEFORE UPDATE/DELETE` trigger, and `{{#outbox}}` second migration stub.

### T2.6 `src/models/audit.ts` (read-only Lucid model)

`save/delete/$getQueryFor(update|delete)` throw `E_AUDIT_IMMUTABLE`. Static scopes: `forModel(model)`, `forRef(type, id)`, `byActor(actor)`, `inTenant(id)`, `between(a, b)`, `event(name)`; `cursorPaginate` on `seq`.

### T2.7 `providers/audit_provider.ts`

```ts
export default class AuditProvider {
  register() {
    this.app.container.singleton('audit.manager', /* resolve config provider → StoreManager */)
    this.app.container.singleton('audit.pipeline', ...)
    this.app.container.singleton('audit', ...)        // facade
  }
  async boot() { /* bind container bindings types via declare module '@adonisjs/core/types' */ }
  async start() { pipeline.startFlusher(); if (outbox) startDrainer() + replayOnBoot() }
  async shutdown() { await pipeline.shutdown() }
}
```

Register the shutdown work **in the provider's own `shutdown`** and document v7 behavior: shutdown hooks run in reverse registration order, so the audit provider should be registered **before** the database provider closes connections — verify in an integration test that the final flush still has a live DB connection.

### T2.8 `services/main.ts` (facade)

```ts
import app from '@adonisjs/core/services/app'
let audit: AuditService
await app.booted(async () => { audit = await app.container.make('audit') })
export { audit as default }
```

Facade API: `log(event).on(model|ref).by(actor).withMeta(m).withOld(o).withNew(n).tag(...t).commit() / commitSync()`, `withinContext(store, fn)`, `stats()`.

**Tests:**
- `tests/unit/pipeline.spec.ts` — batching by size & interval, overflow strategies, retry/backoff (fake timers), DLQ file write, shutdown drain, `requestCoupledFlush` timeout path.
- `tests/integration/lucid_store.spec.ts` (SQLite) — write/chain/head/verify roundtrip; immutability model errors.
- `tests/integration/context.spec.ts` — ALS propagation through async hops; lazy actor resolution; console fallback.
- `tests/integration/provider.spec.ts` — boot, facade resolves, graceful shutdown flushes pending events.

**AC (M2):** an event sent via the facade lands chained in SQLite `audits` with correct `seq/hash/prev_hash`; kill-during-pending test shows shutdown flush works; coverage ≥ 85% overall.

---

# Milestone 3 — Auditable Mixin & Domain Events (Week 3–4)

### T3.1 `src/mixins/auditable.ts`

```ts
export function Auditable<T extends NormalizeConstructor<typeof BaseModel>>(superclass: T) {
  class AuditableModel extends superclass {
    static auditConfig?: AuditableModelConfig
    static bootIfNotBooted() {
      super.bootIfNotBooted()
      if (registered.has(this)) return
      registered.add(this)
      this.after('create', (m) => captureModelEvent('created', m))
      this.after('update', (m) => captureModelEvent('updated', m))
      this.after('delete', (m) => captureModelEvent('deleted', m))
    }
    audits() { return Audit.forModel(this) }
    async lastAudit() { ... }
  }
  return AuditableModel
}
```

`captureModelEvent`:
- `updated`: diff from `model.$original` vs current attrs limited to `$dirty` keys → `{ oldValues, newValues }`; skip enqueue if diff empty after `exclude`.
- `created`/`deleted`: snapshot per `snapshot: 'diff' | 'full'` (default full for created/deleted).
- Serialize column values via Lucid column metadata (DateTime → ISO, JSON columns passthrough); exclude `$extras`/computed.
- Soft deletes: detect `deletedAt` column convention or `auditRestoredEvent` config → emit `model.restored` when `deletedAt` transitions non-null → null.
- **Transaction awareness:** if `model.$trx` exists —
  - guarantee `transactional-outbox`: insert into `audit_outbox` using `model.$trx` (atomic with the change), skip in-memory queue;
  - otherwise: register `model.$trx.after('commit', enqueue)` so rolled-back changes are never audited.
- `strict: true` → rethrow enqueue failures; default swallow + `audit:error` event.

### T3.2 Domain-event builder (`src/services/log_builder.ts`)

Implements the fluent API from T2.8; `commitSync()` forces request-coupled semantics for that event regardless of global mode. Typed event names via `KnownAuditEvent` + `AuditEvents` augmentation; ship a doc snippet:

```ts
declare module '@rikology/adonisjs-audit-trail/types' {
  interface AuditEvents { 'invoice.approved': true; 'document.exported': true }
}
```

### T3.3 `src/listeners/auth_listener.ts` (optional wiring)

If `@adonisjs/auth` is installed and `config.captureAuthEvents !== false`, subscribe in provider `boot()` to `session_auth:login_succeeded|login_failed|logout` (+ access-token guard equivalents) → `auth.*` events with ALS transport context. Failed logins record attempted identifier under redaction (`hash` mode by default).

**Tests:**
- `tests/integration/auditable_mixin.spec.ts` — created/updated/deleted/restored; exclude/redact per model; empty-diff suppression; DateTime/JSON column serialization; `$extras` excluded.
- `tests/integration/transactions.spec.ts` — rollback ⇒ zero audits (after-commit mode); outbox row co-committed and drained into `audits` (outbox mode); drainer idempotency (claimed_at + attempts).
- `tests/integration/domain_events.spec.ts` — builder permutations; `commitSync` waits for durable write.
- `tests/unit/log_builder.types.spec.ts` — `expectTypeOf` on event-name union.

**AC (M3):** end-to-end: model save inside HTTP-simulated ALS context produces an audit row with actor/IP/request id, chained, queryable via `post.audits()`.

---

# Milestone 4 — Configure Flow, Stubs & Commands (Week 5)

### T4.1 Stubs (`stubs/`)

| Stub | Destination in host app |
|---|---|
| `config/audit.stub` | `config/audit.ts` (full annotated config, env-driven) |
| `migrations/create_audits_table.stub` | `database/migrations/<ts>_create_audits_table.ts` |
| `migrations/create_audit_outbox_table.stub` | (only when outbox selected) |
| `transformers/audit_transformer.stub` | `app/transformers/audit_transformer.ts` (v7 `BaseTransformer<Audit>` with humanized diff) |
| `start/audit_events.stub` | `start/audit_events.ts` (AuditEvents augmentation example) |

All stubs use the starter's stub format (`{{#var}}…`, `exports({ to: app.makePath(...) })`); `stubsRoot` already exported from `index.ts`.

### T4.2 `configure.ts`

```ts
export async function configure(command: Configure) {
  const outbox = await command.prompt.confirm('Enable transactional outbox mode?')
  const multiTenant = await command.prompt.confirm('Is this a multi-tenant application?')
  const immutability = await command.prompt.confirm('Enforce DB-level immutability triggers?', { default: true })

  const codemods = await command.createCodemods()
  await codemods.makeUsingStub(stubsRoot, 'config/audit.stub', { outbox, multiTenant })
  await codemods.makeUsingStub(stubsRoot, 'migrations/create_audits_table.stub', { immutability, multiTenant })
  if (outbox) await codemods.makeUsingStub(stubsRoot, 'migrations/create_audit_outbox_table.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'transformers/audit_transformer.stub', {})

  await codemods.updateRcFile((rc) => {
    rc.addProvider('@rikology/adonisjs-audit-trail/audit_provider')
    rc.addCommand('@rikology/adonisjs-audit-trail/commands')
  })
  await codemods.registerMiddleware('router', [
    { path: '@rikology/adonisjs-audit-trail/audit_context_middleware' },
  ])
  await codemods.defineEnvValidations({
    variables: { AUDIT_REDACTION_SALT: 'Env.schema.string.optional()' },
    leadingComment: 'Variables for @rikology/adonisjs-audit-trail',
  })
  command.logger.success('@rikology/adonisjs-audit-trail configured. Next: run `node ace migration:run` and review config/audit.ts')
}
```

### T4.3 Ace commands (`commands/`)

- `audit_verify.ts` — `node ace audit:verify [--stream] [--from-seq] [--to-seq] [--json]`; streams `VerifyReport`s; exit 1 on first break (CI/cron-safe); pretty table otherwise.
- `audit_prune.ts` — `node ace audit:prune [--dry-run] [--connection]`; resolves retention policies, calls `archive` hook per segment before delete, prints `PruneReport`.
- `audit_replay_outbox.ts` — drain pending outbox rows (e.g., after extended downtime).
- `audit_stats.ts` — pipeline + table stats.
- `commands/main.ts` exports `getMetaData/command` lazy list for the rc `commands` entry.

**Tests:** `tests/integration/configure.spec.ts` using `@japa/file-system` + the configure command test pattern from official packages (create fake app dir, run command, snapshot generated files, assert rc/kernel/env edits). Command tests via Ace kernel factory against a seeded SQLite db (verify catches a manually corrupted row; prune respects per-event retention and dry-run).

**AC (M4):** a fresh `npm create adonisjs` app + `node ace add ../adonisjs-audit-trail` (local path) yields a working setup with zero manual edits; documented in `tests/e2e/README.md` as a manual checklist plus a scripted CI job.

---

# Milestone 5 — Additional Stores, Verification Hardening & Auth (Week 6)

### T5.1 `src/stores/stream_store.ts`
NDJSON to `stdout` / file path / arbitrary `Writable`. Chains locally (keeps head in memory + sidecar head file for file destination). Backpressure-aware (`await drain`).

### T5.2 `src/stores/http_store.ts`
POST batches to a collector: HMAC-SHA256 signature header over canonical batch, idempotency key = first/last event id, retry handled by pipeline (store throws). Optional "collector returns new head" contract; else local chaining.

### T5.3 `src/stores/fanout_store.ts`
`primary` must succeed (errors propagate to pipeline retry); `mirrors` failures per `mirrorFailure: 'log' | 'throw'`. Only the primary's chain result is returned.

### T5.4 Anchoring (`src/core/anchor.ts`)
Config `chain.anchor: { every: number | 'daily', publish: (head: ChainHead) => Promise<void> }`. Default publishers shipped: file-append and HTTP POST. Verify command gains `--check-anchors`.

### T5.5 GDPR / crypto-shredding (`src/core/subject_crypto.ts`)
Per-subject encryption of configured fields using v7 `EncryptionManager` with a dedicated key store interface (`SubjectKeyStore` contract + Lucid-backed default table `audit_subject_keys`). `node ace audit:forget --subject=<id>` deletes the key. Hash chain remains valid because ciphertext was what got hashed. Mark as **experimental** in docs for 1.0.

**Tests:** store contract test suite run against all four stores (shared `storeContractTests(factory)` helper); anchor publish/verify roundtrip; crypto-shredding: forget → values unreadable, `audit:verify` still green.

**AC (M5):** `stores.fanout({ primary: 'lucid', mirrors: ['siem'] })` works in the e2e app; contract suite green for all stores.

---

# Milestone 6 — Multi-DB Matrix, Concurrency & Performance (Week 7)

### T6.1 Testcontainers matrix
`tests/integration/**` parametrized over SQLite (always) + Postgres 16 + MySQL 8 via `testcontainers` (skipped locally without Docker via env flag; required in CI Linux job).

### T6.2 Concurrency proof
Two app instances (two Ignitor apps, same Postgres) write 5k events each to one stream concurrently → assert: `seq` gapless & unique, chain verifies, advisory lock contention bounded (test asserts no deadlock within timeout). Repeat with `streamBy: 'tenant'` across 10 tenants.

### T6.3 Benchmarks (`benchmarks/`, tinybench, excluded from npm files)
- enqueue overhead per audited `model.save()` (target < 0.2 ms p99, SQLite).
- flush throughput (target ≥ 5k events/s single Postgres connection, batch 200).
- Document results in README; wire `npm run bench`.

### T6.4 Partitioning & ops docs
`docs/operations.md`: Postgres monthly partitioning DDL recipe, INSERT-only role grants, separate `connection: 'audit'`, DLQ monitoring, alert on `audit:dropped`.

**AC (M6):** CI matrix green (SQLite/PG/MySQL × Node 24); concurrency test stable across 20 CI runs (run it 3× in the job); benchmark numbers recorded.

---

# Milestone 7 — Docs, CI/CD & 1.0 Release (Week 8–9)

### T7.1 CI — extend starter's `.github/workflows/checks.yml`

```yaml
jobs:
  lint: { ... }           # npm run lint + typecheck
  test-unit:              # ubuntu + windows, node 24
  test-integration:       # ubuntu, services: postgres:16, mysql:8 (or testcontainers)
  e2e-configure:          # scaffold fresh v7 app, node ace add <local pkg>, migrate, smoke test
```

Keep the starter's `release.yml` (release-it + npm provenance; `publishConfig.provenance: true` already set).

### T7.2 Documentation set
- `README.md` — quickstart (install → configure → mixin → query), badges, benchmark table.
- `docs/` — configuration reference, guarantee modes decision guide, tamper-evidence & verification, redaction/GDPR, retention/pruning, multi-tenancy, stores, recipes (Inertia audit viewer using the transformer, SIEM shipping via stream store), threat model table, upgrade policy (hash-field list is frozen per schemaVersion).
- `CHANGELOG.md` via conventional-changelog (automatic).

### T7.3 Release train
1. `0.1.0` after M2 (core + lucid store, "alpha" tag) — early feedback.
2. `0.5.0` after M4 (configure flow) — "beta".
3. `1.0.0` after M6 + docs. `npm run release` (release-it handles tag, GH release, publish).

### T7.4 Pre-1.0 hardening checklist
- [ ] `npm pack --dry-run` — only `build/**` (+stubs), no tests/bin.
- [ ] All exports resolve from a clean install in the e2e app (ESM + `tsc --noEmit` in host).
- [ ] Error classes: every throw is a typed `@poppinss/exception`-style error with `code` (`E_AUDIT_*`).
- [ ] No floating promises (`eslint @typescript-eslint/no-floating-promises: error`).
- [ ] SECURITY.md (starter ships one — fill in contact).
- [ ] License/author/keywords finalized.

---

## Dependency & risk register

| Risk | Mitigation | Owner task |
|---|---|---|
| v7 codemod APIs differ from documented v6 patterns (`registerMiddleware`, `defineEnvValidations`) | Verify against `@adonisjs/core@^7` source in T4.2 before writing stubs; the e2e-configure CI job catches drift | T4.2 |
| Shutdown ordering (reverse hooks) closes DB before final flush | Integration test in T2.7; fallback: DLQ NDJSON dump on write failure during shutdown | T2.7 |
| Advisory-lock semantics differ per dialect | Dialect-gated implementation + concurrency matrix test | T2.4 / T6.2 |
| Canonical JSON drift across releases | Frozen hash-field list, golden test vectors committed, schemaVersion bump policy | T1.4 |
| `@adonisjs/auth` event names change | Optional listener guarded by try-import + version check; contract test pinned to peer range | T3.3 |
| Lucid `bootIfNotBooted` hook double-registration with HMR | `registered` WeakSet keyed by constructor; HMR test in e2e app | T3.1 |

## Task → file quick index

```
M1: src/{types,define_config}.ts  src/core/{canonical_json,hash_chain,redactor,assembler}.ts  src/stores/main.ts
M2: src/audit_context.ts  src/middleware/audit_context_middleware.ts  src/core/pipeline.ts
    src/stores/lucid_store.ts  src/models/audit.ts  providers/audit_provider.ts  services/main.ts
M3: src/mixins/auditable.ts  src/services/log_builder.ts  src/listeners/auth_listener.ts
M4: configure.ts  stubs/**  commands/{main,audit_verify,audit_prune,audit_replay_outbox,audit_stats}.ts
M5: src/stores/{stream_store,http_store,fanout_store}.ts  src/core/{anchor,subject_crypto}.ts
M6: tests matrix + benchmarks/  docs/operations.md
M7: docs/** + CI + release
```
