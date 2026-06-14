# 002 — Outbox drainer: dead-letter poison rows instead of retrying forever

**Category**: correctness
**Effort**: M
**Planned at**: commit `47d0818`, 2026-06-13
**Status**: DONE
**Issue**: —

## Why this matters

The transactional-outbox guarantee mode writes each audit batch as a row in the
`audit_outbox` table; a background drainer (`AuditOutboxDrainer`) claims rows, writes
them to the real store, and marks them processed. If a single row's `payload` is
malformed — corrupt JSON, or a record that doesn't normalize to any audit event —
`normalizePayload()` throws. The current `catch` block resets `claimed_at` to `null`,
which makes the row immediately re-claimable. There is no attempt cap, so that one
poison row is claimed, fails, reset, re-claimed, fails… **forever**, on every drain
tick (default every 1s). The drainer never dead-letters it and never gives up.

Impact: one bad row permanently consumes drain budget and floods logs; if the row sorts
early by `id`, it can also crowd out the `limit`-sized batch and slow delivery of good
events. A compliance tool must fail loud and bounded, not loop silently.

The `audit_outbox.attempts` column already exists and is already incremented on every
claim (`#claim()` writes `attempts: Number(row.attempts ?? 0) + 1`). We will use it as
the give-up signal. We will **not** change the migration schema (existing installs must
keep working) — `processed_at` already exists and its presence removes a row from the
active queue.

## Current state

`src/core/outbox_drainer.ts` — the relevant pieces as they exist today:

```ts
// top of file
import { AuditOutboxPayloadError } from './errors.js'

const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000
```

```ts
// constructor (lines 56-62)
constructor(
  protected app: ApplicationService,
  protected store: AuditStoreContract,
  staleClaimMs: number = DEFAULT_STALE_CLAIM_MS
) {
  this.#staleClaimMs = staleClaimMs
}
```

```ts
// inside drain(), the per-row loop (lines 99-124)
for (const row of rows) {
  const claimedAt = now.toISOString()
  const claimed = await this.#claim(db, row, claimedAt)
  if (!claimed) {
    continue
  }

  try {
    const events = normalizePayload(row.payload)
    if (events.length > 0) {
      await this.store.write(events)
    }

    const processedAt = new Date().toISOString()
    await db.query().from('audit_outbox').where('id', row.id).update({
      processed_at: processedAt,
      updated_at: processedAt,
    })
    processed++
  } catch {
    await db.query().from('audit_outbox').where('id', row.id).update({
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
  }
}
```

Note `OutboxRow` already carries `attempts?: number | string | null` (lines 8-12) and
`#claim()` already increments it. After a successful `#claim()` for `row`, the row's
attempt count in the DB is `Number(row.attempts ?? 0) + 1`.

## Repo conventions to follow

- All thrown errors in `src/` are typed `E_AUDIT_*` classes from `src/core/errors.ts`
  (e.g. `AuditOutboxPayloadError`). Do not introduce plain `throw new Error(...)`.
- Files are `snake_case`; private class members use `#name`; ESM with `.js` import
  specifiers (e.g. `import { X } from './errors.js'`).
- Side-effect logging in stores uses `console.error(...)` (see
  `src/stores/fanout_store.ts:69-71`). The drainer has no event emitter, so use a small
  injectable callback with a `console.error` default — mirror the dead-letter callback
  pattern in `src/core/pipeline.ts:48,74` (`#deadLetterHandler` with a default function).

## Implementation steps

### Step 1 — Add a max-attempts constant and an injectable poison handler

In `src/core/outbox_drainer.ts`, near `DEFAULT_STALE_CLAIM_MS` (line 6), add:

```ts
const DEFAULT_MAX_ATTEMPTS = 5
```

Add a poison-handler type and field. The handler receives the row id and its parsed-or-raw
payload so the operator can preserve it. Default implementation logs to `console.error`.

- Add a class field `#maxAttempts: number` and `#onPoison: (info: { id: string | number; payload: unknown; attempts: number }) => void`.
- Extend the constructor signature with two optional params (keep `staleClaimMs` as the
  third positional param so existing callers in `providers/audit_provider.ts:63` keep
  working unchanged):

```ts
constructor(
  protected app: ApplicationService,
  protected store: AuditStoreContract,
  staleClaimMs: number = DEFAULT_STALE_CLAIM_MS,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  onPoison: (info: { id: string | number; payload: unknown; attempts: number }) => void =
    defaultPoisonHandler
) {
  this.#staleClaimMs = staleClaimMs
  this.#maxAttempts = maxAttempts
  this.#onPoison = onPoison
}
```

Add the default handler near the bottom of the file (module scope, not a class member):

```ts
function defaultPoisonHandler(info: { id: string | number; attempts: number }): void {
  console.error(
    `Audit outbox row ${info.id} failed ${info.attempts} times and was dead-lettered; ` +
      `payload is irrecoverable and the row has been marked processed.`
  )
}
```

### Step 2 — Dead-letter the row when its attempt count reaches the cap

Replace the `catch {}` block in the per-row loop (current lines 118-123) with logic that
checks the attempt count. The attempt count after this claim is
`Number(row.attempts ?? 0) + 1` (the same value `#claim` just wrote).

```ts
} catch {
  const attempts = Number(row.attempts ?? 0) + 1

  if (attempts >= this.#maxAttempts) {
    // Poison row: irrecoverable. Mark it processed so it leaves the active queue,
    // then hand the raw payload to the poison handler for preservation/alerting.
    const failedAt = new Date().toISOString()
    await db.query().from('audit_outbox').where('id', row.id).update({
      processed_at: failedAt,
      updated_at: failedAt,
    })
    this.#onPoison({ id: row.id, payload: row.payload, attempts })
    continue
  }

  // Transient failure: release the claim so it is retried on a later tick.
  await db.query().from('audit_outbox').where('id', row.id).update({
    claimed_at: null,
    updated_at: new Date().toISOString(),
  })
}
```

Do not change `#claim()`, `normalizePayload()`, or the SELECT query.

### Step 3 — Typecheck and lint

```bash
npm run typecheck   # expect: exits 0
npm run lint        # expect: exits 0
```

### Step 4 — Write the regression test

Create `tests/integration/outbox_drainer.spec.ts`. Model the bootstrap on an existing
integration test that builds an AdonisJS app + Lucid connection; the closest existing
patterns are `tests/integration/commands.spec.ts` and `tests/helpers/app.ts` /
`tests/helpers/migrate.ts`. **Open those files and copy their app/db bootstrap exactly**
— do not invent a new harness. The test must run under SQLite (`SKIP_DOCKER_TESTS=1`).

The test must:

1. Create the `audit_outbox` table (use the same migration/helper the other integration
   tests use; the schema matches `stubs/migrations/create_audit_outbox_table.stub`:
   columns `id` uuid PK, `payload` jsonb, `attempts` int default 0, `claimed_at`,
   `processed_at`, `created_at`, `updated_at`).
2. Insert one row whose `payload` is malformed so `normalizePayload` throws — e.g. a JSON
   object that is not an audit event and has no `events`/`event` keys:
   `{ "garbage": true }` (stringify it the same way real rows are stored).
3. Construct an `AuditOutboxDrainer` with a small `maxAttempts` (e.g. `3`), a no-op store
   whose `write` is never expected to be called for this row, and a spy `onPoison` that
   records calls (e.g. push to an array).
4. Call `await drainer.drain()` in a loop `maxAttempts` times.
5. Assert:
   - `onPoison` was called **exactly once**, with `attempts >= 3`.
   - The row now has a non-null `processed_at` (query the table).
   - A subsequent `await drainer.drain()` does **not** call `onPoison` again and does not
     re-claim the row (the row stays processed).

Also add a happy-path/transient assertion to prove good rows still flow:

6. Insert a second row with a **valid** serialized audit-event payload (copy the shape
   from an existing fixture — see `tests/helpers/models.ts` or how
   `tests/integration/commands.spec.ts` builds events; at minimum the object must satisfy
   `isAuditEvent`: a record with string `id` and string `event`). Drain once and assert
   the configured store's `write` received it and the row's `processed_at` is set.

Run it:

```bash
SKIP_DOCKER_TESTS=1 npm run quick:test -- --files=tests/integration/outbox_drainer.spec.ts
# expect: all assertions pass
```

### Step 5 — Full suite

```bash
npm run lint && npm run typecheck && SKIP_DOCKER_TESTS=1 npm run quick:test
# expect: all green, no pre-existing tests broken
```

## In scope

- `src/core/outbox_drainer.ts` (edit)
- `tests/integration/outbox_drainer.spec.ts` (create)

## Out of scope

- `stubs/migrations/create_audit_outbox_table.stub` — do **not** add columns; the fix must
  work on existing installs using only `processed_at`/`attempts`.
- `providers/audit_provider.ts` — the new constructor params are optional; do not change
  the existing `new AuditOutboxDrainer(this.app, manager.use())` call.
- `src/core/errors.ts`, the pipeline, any store implementation.

## Done criteria

- `npm run lint` exits 0.
- `npm run typecheck` exits 0.
- `SKIP_DOCKER_TESTS=1 npm run quick:test` passes, including the new
  `tests/integration/outbox_drainer.spec.ts`.
- `git status` shows only the two in-scope files changed (plus `plans/README.md` status row).
- A poison row is dead-lettered exactly once and marked `processed_at`; it is never
  re-claimed after reaching `maxAttempts`.

## STOP and report back if

- `src/core/outbox_drainer.ts` no longer matches the "Current state" excerpts (the catch
  block or `#claim` was already changed).
- No existing integration test demonstrates how to build an AdonisJS app + SQLite Lucid
  connection that you can copy — rather than inventing a harness, stop and report.
- Adding the constructor params would require changing the call site in
  `providers/audit_provider.ts` (it should not — they are optional).

## Maintenance note

Reviewers: confirm `maxAttempts` is the post-claim count (a row dead-letters on the Nth
*failure*, not the N+1th). Watch that `processed_at` being set on a poison row doesn't get
misread elsewhere as "successfully delivered" — `audit:stats`/replay tooling treats
`processed_at` as "done", which is intended here (the payload is irrecoverable). If a
future change adds a dedicated `failed_at` column via migration, prefer that over
overloading `processed_at`.
