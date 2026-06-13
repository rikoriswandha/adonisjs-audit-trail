# Changelog

All notable changes to this project will be documented in this file. The format is based on [Conventional Commits](https://www.conventionalcommits.org/) and this project adheres to [Semantic Versioning](https://semver.org/).

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
