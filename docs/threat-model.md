# Threat model

| Threat | Mitigation | Residual risk |
| ------ | ---------- | ------------- |
| App-level row tampering | Read-only Lucid model + DB immutability trigger + INSERT-only grants | A privileged DBA can bypass triggers/grants. |
| DBA/attacker edits rows | Hash chain breaks; `audit:verify` detects the first modified row | Whole-suffix truncation requires anchoring to detect. |
| Suffix truncation (delete newest rows) | Periodic external anchoring of chain head | Anchors must be stored outside the same database. |
| Lost events on crash | Graceful-shutdown flush; `transactional-outbox` for atomicity | Process hard-kill can still lose in-memory best-effort events. |
| Audit of audit access | Optional `audit.viewed` events emitted by repository reads | Must be enabled by the application. |
| PII leakage in trails | Field-level redaction modes; crypto-shredding for erasure | Misconfigured model `redact` arrays can leak data. |
| Clock skew breaking order | `seq` is the order key; timestamps are informational | — |
| Replay attacks on HTTP store | HMAC-SHA256 signature + idempotency key per batch | Secret rotation must be coordinated. |
| Queue overflow | Configurable overflow strategy + `audit:dropped` alert | Alerts must be wired to paging. |

## Trust boundaries

- **Application** writes audits; should not have `UPDATE`/`DELETE` rights on `audits`.
- **Maintenance role** runs prune/replay; should be used only in scheduled jobs or manual ops.
- **External anchor / archive** should be in a separate trust boundary from the application database.
