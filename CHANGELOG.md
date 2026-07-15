# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/) and uses [Conventional Commits](https://www.conventionalcommits.org/) for changelog generation. Releases are managed with `release-it`; contributors do not need to edit this file manually.

## Unreleased

## 1.2.0 - 2026-07-15

### Added

- Unified guarantee-aware submission for explicit events, model hooks, and authentication listeners, including caller-owned Lucid transactions.
- Idempotent two-connection transactional-outbox relay with durable claim, retry, failure, requeue, poison-row, and metrics state.
- Tenant-aware source executors for keeping PostgreSQL transaction-local RLS context attached to outbox claims and acknowledgements.
- Public audit query, stream discovery, transaction-bound store, retention, subject-key, anchor, and typed delivery-error contracts.
- Durable archive markers and chain checkpoints so retention retries are idempotent and verification can continue after pruning.
- Runnable AdonisJS demo application under `examples/demo`.

### Changed

- `Auditable` model hooks now route through `AuditService`; transactional-outbox events are written in the business transaction and non-outbox events are submitted after commit.
- Pipeline shutdown, fanout, stream, Lucid, and delivery notification paths now preserve ordering and report terminal failures consistently.
- `audit:verify` discovers streams from the configured store and supports named connections.
- Generated migrations create tables before deferred PostgreSQL, MySQL, or SQLite immutability triggers.
- The packed consumer harness now verifies fresh SQLite, PostgreSQL, and MySQL applications.

### Fixed

- Transactional-outbox configure selections now generate the selected guarantee, source connection, and source table without unused imports.
- Outbox target success followed by source acknowledgement failure now replays without duplicating the target event or delivery notification.
- Malformed multi-event outbox payloads fail atomically instead of partially reaching the target.
- Crypto-shredding keys are tenant-scoped and first-write-wins; tenant IDs and redaction hash inputs are validated and normalized.
- Retention maintenance can prune immutable rows through an explicit dialect-specific maintenance callback while ordinary updates and deletes remain blocked.
- `audit_outbox` migrations now match the runtime UUID, payload, tenant, lifecycle, retry, timestamp, and error columns.
- Non-interactive configure flags no longer hang CI or generate missing artifacts.
- ESLint ignores `examples/**`, so source builds do not depend on the root TypeScript project including the demo.

## 1.0.0

### Added

- Initial stable release.
- Tamper-evident audit trail with SHA-256 hash chains.
- `Auditable` Lucid mixin for automatic create/update/delete/restore capture.
- Fluent domain-event API (`audit.log(...)`).
- Async batched write pipeline with `best-effort`, `request-coupled`, and `transactional-outbox` guarantees.
- Lucid, stream, HTTP, and fanout storage drivers.
- PII redaction (`mask`/`remove`/`hash`) and experimental crypto-shredding.
- `node ace audit:verify`, `audit:prune`, `audit:replay-outbox`, `audit:stats`, and `audit:forget` commands.
- AdonisJS v7 configure flow, middleware, provider, and transformer stub.
- Full test suite and GitHub Actions CI/CD pipeline.
