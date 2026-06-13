# Guarantee modes

The library offers three delivery guarantees. Choose the mode per config and override per call when needed.

| Mode | Behavior | Best for |
| ---- | ---------- | -------- |
| `best-effort` (default) | Enqueue in memory and flush asynchronously. A graceful-shutdown hook drains the queue. | High-volume, non-regulated events. |
| `request-coupled` | The HTTP response waits until the request's events are flushed (with timeout). | Moderate assurance without schema changes. |
| `transactional-outbox` | Audit rows are written to `audit_outbox` inside the same DB transaction as the business change, then drained into `audits`. | Regulated/financial flows requiring atomicity. |

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
- The `Auditable` mixin auto-detects `model.$trx` and writes the outbox row in the same transaction.
- A background drainer moves rows to `audits` and tracks them with `claimed_at`/`attempts` for idempotency.
- Crash-safe: pending rows are replayed on boot.

```ts
export default defineConfig({
  guarantee: 'transactional-outbox',
})
```

Use `node ace audit:replay-outbox` to drain manually after extended downtime.

## Choosing a mode

- Start with `best-effort` for model-change auditing in normal web apps.
- Use `request-coupled` for sensitive actions (deletes, permission changes) where you can afford a small latency penalty.
- Reserve `transactional-outbox` for compliance-driven flows where audit loss or dual-write divergence is unacceptable.
