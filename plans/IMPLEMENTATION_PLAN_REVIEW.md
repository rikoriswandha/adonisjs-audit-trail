# Implementation Plan Review

Review target: `docs/IMPLEMENTATION_PLAN.md`  
Project reviewed: `@rikology/adonisjs-audit-trail` current workspace  
Review date: 2026-06-13

## Executive verdict

Original review finding: the project was far beyond scaffold state and implemented most planned package surface, but several 1.0 acceptance criteria were only partially implemented or partially verified.


## Fix status

All findings in this review have been addressed in the current workspace:

- Docker/Testcontainers failures are fatal unless `SKIP_DOCKER_TESTS=1` is explicitly set.
- Outbox draining uses conditional row claims before processing.
- Domain-event commits handle pipeline enqueue rejection with typed audit errors.
- Payload truncation now covers `oldValues`, `newValues`, and `metadata`.
- Console fallback actor resolution now emits `cli`.
- HTTP store verification/pruning use a local chained log instead of placeholder success.
- `audit:prune` supports `--connection` and archive-before-delete.
- Root `stubsRoot` is exported.
- Source-side plain `throw new Error` matches were removed from `src/`, `providers/`, and `commands/`.

Post-fix local verification:

| Command | Result |
|---|---:|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `SKIP_DOCKER_TESTS=1 npm run quick:test -- --files=tests/unit/assembler.spec.ts --files=tests/unit/audit_service.spec.ts --files=tests/integration/stores.spec.ts --files=tests/integration/transactions.spec.ts --files=tests/integration/commands.spec.ts` | Pass, 43 tests |
| `SKIP_DOCKER_TESTS=1 npm test` | Pass, 131 tests |
| `npm run compile` | Pass |
| `npm pack --dry-run` | Pass |

## Verification run during review

Commands run from repo root:

| Command | Result | Notes |
|---|---:|---|
| `npm run typecheck` | Pass | TypeScript diagnostics clean. |
| `npm run lint` | Pass | ESLint completed without reported issues. |
| `SKIP_DOCKER_TESTS=1 npm run quick:test` | Pass | 118 tests passed; Docker-backed tests intentionally skipped. |
| `npm run compile` | Pass | `tsdown` built configured entrypoints; stubs and `commands.json` copied in `postcompile`. |
| `SKIP_DOCKER_TESTS=1 npm test` | Pass | 118 tests passed; coverage: all files 89.55%, `src/core` 91.85%. |
| `npm pack --dry-run` | Pass | Tarball contains `build/**`, stubs, package metadata, README, and license; no tests/bin entries observed. |

Not verified locally: Postgres/MySQL Testcontainers matrix and the 5k+5k concurrency proof, because the local test run explicitly used `SKIP_DOCKER_TESTS=1`.

## Milestone status

| Milestone | Status | Evidence | Remaining gap |
|---|---|---|---|
| M0 — Scaffold & Toolchain | Mostly complete | `package.json` has the planned name, exports, peer deps, Node >=24, tsdown entries, test/compile scripts. `npm run compile`, `npm run typecheck`, and tests pass. | `index.ts` exports `configure` and public types, but not `stubsRoot` as called out in the plan. |
| M1 — Types, Config & Canonical Core | Mostly complete | `src/types.ts`, `src/define_config.ts`, `src/stores/main.ts`, and `src/core/{canonical_json,hash_chain,redactor,assembler}.ts` exist. Core coverage is 91.85%. `src/types.ts` has no `any` matches. | Payload cap is only applied to `newValues`, not `oldValues` or `metadata`. Some thrown errors are plain `Error`. |
| M2 — Context, Pipeline & Lucid Store | Mostly complete | `src/audit_context.ts`, middleware, pipeline, Lucid store, migration stubs, audit model, provider, and service facade exist. SQLite tests pass. | CLI actor fallback is not console-aware. Pipeline enqueue failures can be ignored by facade calls. |
| M3 — Auditable Mixin & Domain Events | Mostly complete | `src/mixins/auditable.ts`, `src/services/log_builder.ts`, and `src/listeners/auth_listener.ts` exist with integration tests. | Transactional outbox draining is not safe for concurrent drainers and does not enforce idempotent claiming. |
| M4 — Configure Flow, Stubs & Commands | Mostly complete | `configure.ts`, stubs, command modules, and `commands/commands.json` exist. Configure and command tests pass. | `audit:prune` lacks the planned `--connection` option and does not invoke the retention `archive` hook before deletes. |
| M5 — Additional Stores, Verification Hardening & Auth | Partial | Stream, HTTP, fanout, anchor, subject crypto, and auth listener files exist; tests pass in SQLite/local mode. | HTTP store `verify()` always yields valid and `prune()` is a no-op. Store contract tests disable verification/prune for HTTP and some stream modes. |
| M6 — Multi-DB Matrix, Concurrency & Performance | Partial / not locally verified | CI has a DB matrix job and concurrency tests exist. Benchmarks exist under `benchmarks/`. | Testcontainers startup failures return `null` and affected tests return early, so CI can pass without actually proving Postgres/MySQL/concurrency. Benchmark results are documented only for SQLite in README. |
| M7 — Docs, CI/CD & 1.0 Release | Partial | README and docs set exist; CI and release workflows exist; `npm pack --dry-run` excludes tests/bin. | Typed `E_AUDIT_*` errors are not used consistently. Docker matrix proof is not fail-closed. |

## Findings to fix before treating this as plan-complete

### P0 — Docker/concurrency tests can silently skip in CI

Evidence:

- `tests/helpers/containers.ts:68-72` and `tests/helpers/containers.ts:99-103` catch container startup failures, log a warning, stop any partial container, then return `null`.
- `tests/integration/concurrency.spec.ts:64-68` and `tests/integration/concurrency.spec.ts:116-120` treat `null` as a skipped proof by returning early.
- `.github/workflows/checks.yml:61-66` runs `npm run quick:test` three times for integration, but does not set a fail-closed environment flag.

Impact: M6 says Postgres/MySQL matrix and concurrency are required in CI. Current CI can pass when Docker/Testcontainers is unavailable or broken, which means the advisory-lock and gapless-sequence guarantees may be unproven.

Recommended fix: make Testcontainers failures fatal unless `SKIP_DOCKER_TESTS=1` is explicitly set. Keep local skip behavior, but fail CI when Docker-backed tests are expected.

### P0 — Outbox drainer is not concurrency-safe

Evidence:

- `src/core/outbox_drainer.ts:78-83` selects rows with `whereNull('processed_at')` only.
- `src/core/outbox_drainer.ts:91-95` writes `claimed_at` and increments `attempts`, but the update is not conditional on `claimed_at` still being null.
- `src/core/outbox_drainer.ts:97-107` writes events to the store, then marks `processed_at`.

Impact: Two drainers can select the same unprocessed row before either claim update lands, both write the same audit event batch, and then both mark the row processed. This weakens the T3/T4 outbox idempotency requirement.

Recommended fix: claim atomically with a conditional update (`processed_at IS NULL AND claimed_at IS NULL` or expired claim), check affected row count, then process only claimed rows. Add a two-drainer test that proves a single outbox row is written once.

### P1 — Facade ignores enqueue rejection and can turn overflow into silent loss or timeout

Evidence:

- `src/services/audit.ts:38-44` and `src/services/audit.ts:47-50` call `this.pipeline.enqueue(event)` but do not inspect the returned boolean.
- `src/core/pipeline.ts:187-205` returns `false` for `dropNew` and for `block` when the buffer is still full.

Impact: `commit()` can report success after the pipeline rejected an event. `commitSync()` can wait for an event id that was never queued and fail only by timeout. This is weaker than the plan's request-coupled/strict guarantee semantics.

Recommended fix: handle `false` in `AuditService.emitLog()` and `emitLogSync()`. For best-effort, emit/return a typed dropped result or error event. For request-coupled and commitSync, throw a typed `E_AUDIT_DROPPED`/store error immediately.

### P1 — HTTP store verification and pruning are placeholders

Evidence:

- `src/stores/http_store.ts:73-82` makes `verify()` yield `{ valid: true, checkedCount: 0 }` and `prune()` return an empty report.
- `tests/integration/stores.spec.ts:66-89` registers the HTTP store contract with `{ verifiable: false, corruptable: false, prunable: false }`.

Impact: M5 says the shared store contract suite runs against all four stores and that verification hardening is part of the milestone. The HTTP store currently only proves write/post behavior, not integrity verification or retention behavior.

Recommended fix: either document HTTP as write-only and explicitly reduce the plan scope, or implement a collector/head contract that supports verification/prune semantics and enable the shared contract capabilities for HTTP.

### P1 — Payload size cap only applies to `newValues`

Evidence:

- `src/core/assembler.ts:68-84` truncates only the `newValues` object.
- `src/core/assembler.ts:102-104` assigns `oldValues` and `metadata` directly.
- `stubs/config/audit.stub:73-76` documents the cap as applying to old/new values and metadata.

Impact: Large `oldValues` or `metadata` can bypass the configured `payloadMaxBytes`, increasing request memory, queue memory, and stored row size. This does not match T1.6 or the generated config comments.

Recommended fix: apply the same truncation/hash marker policy independently to `oldValues`, `newValues`, and `metadata`, or cap the combined serialized payload and test all three fields.

### P1 — CLI actor fallback is not implemented

Evidence:

- `src/core/assembler.ts:55-63` returns `{ type: 'system', id: null }` when no actor is present or a lazy actor resolves null.

Impact: T2.1 requires fallback to `{ type: 'cli', id: null }` when the app environment is console. Domain events emitted from Ace commands will be attributed as `system` unless callers explicitly set `.by()`.

Recommended fix: pass environment into `assembleEvent()` config, or resolve fallback actor in `AuditService` where the application service is available. Add an integration test for console/app command context.

### P2 — M7 typed-error checklist is not satisfied

Evidence:

- `src/core/errors.ts` defines typed audit errors with `code` fields.
- Plain `Error` is still thrown in multiple source files, including `src/define_config.ts:95-96`, `src/define_config.ts:191-195`, `src/core/anchor.ts:94-95`, `src/core/outbox_drainer.ts:31-47`, `src/mixins/auditable.ts:159-160`, and `src/stores/store_manager.ts:15-16`.

Impact: The pre-1.0 hardening checklist says every throw should be a typed `E_AUDIT_*` error. Current callers cannot reliably branch on `code` for several operational failures.

Recommended fix: add specific error classes/codes for config, dependency, anchor publish, invalid outbox payload, dropped enqueue, and missing store cases. Replace plain throws and add tests asserting the `code` values.

### P2 — `audit:prune` is missing planned retention features

Evidence:

- `commands/audit_prune.ts:9-27` exposes `--event` and `--dry-run`, then calls `store.prune(policy)`.
- There is no `--connection` flag in the command file.
- The command does not invoke `config.retention.archive` before deletion.

Impact: T4.3 requires `node ace audit:prune [--dry-run] [--connection]`, resolving retention policies, calling the archive hook per segment before delete, and then printing `PruneReport`. Current prune is useful, but not the full planned operational path.

Recommended fix: add `--connection`, thread it to the selected store/manager path, and implement archive-before-delete either in the command orchestration or as a store contract extension that receives retention segments.

### P3 — Root entrypoint does not export `stubsRoot`

Evidence:

- `index.ts:10-11` exports `configure`, `defineConfig`, and `stores`, then public types.
- `stubs/main.ts:7-8` exports `stubsRoot`.
- T0.1/T4.1 describe the starter entrypoint as exporting `{ configure, stubsRoot }`.

Impact: Package consumers cannot import `stubsRoot` from the root entrypoint. This may not affect `node ace add`, because `configure.ts` uses its own local `stubsRoot`, but it is still a mismatch with the plan.

Recommended fix: export `stubsRoot` from `index.ts` if that is still part of the public package contract; otherwise update the implementation plan to remove the requirement.

## Positive checks

- Package identity and peer dependency strategy match the plan: `@adonisjs/core`, `@adonisjs/assembler`, `@adonisjs/lucid`, `@adonisjs/auth`, and `luxon` are peers; host-installed packages are not direct runtime deps.
- Source layout follows the one-way dependency rule: no `src/**` imports from `providers/**` were observed in the reviewed summaries/searches.
- Core hash field selection matches the plan: `src/core/hash_chain.ts:9-28` includes `id`, `seq`, `stream`, event/model/value/metadata fields, actor type/id, tenant, schema version, createdAt, and prevHash; it excludes actor label, tags, and transport fields.
- Local coverage exceeds the stated M2 overall target and M1 core target in the SQLite run: all files 89.55%, `src/core` 91.85%.
- `npm pack --dry-run` did not include tests or bin files.

## Recommended next order

1. Make DB/Testcontainers tests fail-closed in CI, then run the full PostgreSQL/MySQL matrix.
2. Fix outbox atomic claiming and add a concurrent-drainer regression test.
3. Fix facade handling for `enqueue(false)` and request-coupled overflow semantics.
4. Decide whether HTTP store is write-only or contract-complete; update either implementation or plan/docs/tests.
5. Apply payload cap to `oldValues` and `metadata`.
6. Replace remaining plain `Error` throws with typed `E_AUDIT_*` errors.
7. Fill prune archive/connection behavior and root `stubsRoot` export if still required.
