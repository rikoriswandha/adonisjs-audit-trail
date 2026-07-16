# Guarantee modes

The library offers three delivery guarantees. Choose the mode per config and override per call when needed.

| Mode | Behavior | Best for |
| ---- | ---------- | -------- |
| `best-effort` (default) | Enqueue in memory and flush asynchronously. A graceful-shutdown hook drains the queue. | High-volume, non-regulated events. |
| `request-coupled` | The HTTP response waits until the request's events are flushed (with timeout). | Moderate assurance without schema changes. |
| `transactional-outbox` | Synchronously persists a durable source intent in the caller-owned business transaction, then delivers it to `audits` asynchronously. | Regulated/financial flows that require business data and audit source intent to commit together. |

## `best-effort`

- Fastest; enqueue is O(1).
- Bounded in-memory queue (default 10,000 events).
- Configurable overflow: `dropOldest`, `dropNew`, or `block`.
- Emits `audit:dropped` when overflow occurs.
- Final flush on shutdown.

```ts
export default defineConfig({
  guarantee: 'best-effort',
})
```

## `request-coupled`

- The middleware tracks events produced during the request.
- The response is held until the flush completes or `requestCoupledTimeoutMs` elapses.
- Timeout throws `E_AUDIT_COUPLED_TIMEOUT` unless `coupledFailure: 'ignore'`.

```ts
export default defineConfig({
  guarantee: 'request-coupled',
  requestCoupledTimeoutMs: 5_000,
})
```

Override for a single domain event with `commitSync()`:

```ts
await audit.log('document.purge_requested').on(doc).commitSync()
```

## `transactional-outbox`

- Requires the `audit_outbox` migration.
- Model writes **must** join the caller-owned transaction with `model.useTransaction(trx)` before business DML; missing transaction ownership is rejected.
- The mixin synchronously writes a durable source intent in that transaction. If intent persistence fails, the operation rejects and the transaction rolls back regardless of `auditConfig.strict`.
- A background drainer asynchronously delivers source intents to `audits` and tracks rows with `claimed_at`/`attempts` for idempotency. Target delivery is not atomic with the business transaction.
- Crash-safe source intent: pending rows are replayed on boot.
- Automatic auth emitter capture defaults to off in this mode. `captureAuthEvents: true` is rejected because auth emitter payloads do not carry the caller-owned business transaction required for fail-closed outbox persistence.

For an auth-related audit intent that must commit atomically with business state, emit it explicitly at the business operation boundary:

```ts
await db.transaction(async (trx) => {
  // Perform the auth-related business write with trx.
  await audit.log('auth.login').withTransaction(trx).commit()
})
```

The source intent is atomic with `trx`; the drainer delivers the target audit record asynchronously.


```ts
await db.transaction(async (trx) => {
  invoice.useTransaction(trx)
  await invoice.save()
})
```

```ts
export default defineConfig({
  guarantee: 'transactional-outbox',
})
```

Use `node ace audit:replay-outbox` to drain manually after extended downtime.

## Choosing a mode

- Start with `best-effort` for model-change auditing in normal web apps.
- Use `request-coupled` for sensitive actions (deletes, permission changes) where you can afford a small latency penalty.
- Reserve `transactional-outbox` for compliance-driven flows where business data and a durable audit source intent must commit together; target delivery remains asynchronous.
