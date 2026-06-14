# Documentation

Welcome to the `@rikology/adonisjs-audit-trail` documentation.

## Getting started

- [Configuration reference](./configuration.md) — every config option, env variable, and typed event names.
- [Guarantee modes](./guarantee-modes.md) — choosing between best-effort, request-coupled, and transactional-outbox.
- [Stores](./stores.md) — built-in storage drivers and custom store authoring.

## Security & compliance

- [Tamper evidence & verification](./tamper-evidence.md) — how the hash chain works and what to do if verification fails.
- [Redaction & GDPR](./redaction-gdpr.md) — masking, hashing, and crypto-shredding sensitive fields.
- [Retention & pruning](./retention.md) — archive and prune old events safely.
- [Threat model](./threat-model.md)
- [Upgrade policy](./upgrade-policy.md)

## Operations & scaling

- [Multi-tenancy](./multi-tenancy.md)
- [Operations guide](./operations.md) — partitioning, role grants, DLQ monitoring, and cron verification.

## Recipes

- [Inertia audit viewer](./recipes/inertia-viewer.md)
- [SIEM shipping](./recipes/siem-shipping.md)

## Design

- [Architecture](./ARCHITECTURE.md) — design rationale and prior-art analysis.
- [Implementation plan](./IMPLEMENTATION_PLAN.md) — original build plan and acceptance criteria.
