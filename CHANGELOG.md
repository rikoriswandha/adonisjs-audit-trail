# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/) and uses [Conventional Commits](https://www.conventionalcommits.org/) for changelog generation. Releases are managed with `release-it`; contributors do not need to edit this file manually.

## Unreleased

### Added

- Runnable AdonisJS demo app under `examples/demo`.

### Fixed

- `audit_outbox` migration stub was missing the `attempts` column that `writeOutbox()` and the drainer write to, causing every transactional-outbox insert to fail with a SQL error.
- `audit_outbox` migration stub used `uuid('id')` but the mixin never populated it; rows shared `NULL` ids so the drainer's claim step matched every row at once and stalled the outbox. Stub now uses an auto-increment id to match the runtime contract.
- `node ace configure` no longer hangs in non-interactive/CI environments; pass `--outbox`/`--no-outbox`, `--multi-tenant`/`--no-multi-tenant`, and `--immutability`/`--no-immutability` to skip the prompts.
- ESLint config now explicitly ignores `examples/**` so building from source no longer depends on the root `tsconfig` exclude.

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
