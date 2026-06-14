# Contributing

Thanks for your interest in improving `@rikology/adonisjs-audit-trail`. This document explains how to set up the project, the conventions we follow, and what to expect when you open a pull request.

## Code of conduct

This project ships a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## Ways to contribute

- **Report a bug** — open an issue with a minimal reproduction.
- **Request a feature** — open an issue describing the use case before sending a PR for anything non-trivial.
- **Report a security issue** — do **not** open a public issue. Follow the [security policy](./SECURITY.md).
- **Improve docs** — typo fixes and clarifications are always welcome.

## Prerequisites

- Node.js `>= 24`
- npm (bundled with Node)
- Docker — optional, only needed to run the Postgres/MySQL integration tests locally

## Getting started

```bash
git clone https://github.com/rikoriswandha/adonisjs-audit-trail.git
cd adonisjs-audit-trail
npm install
```

## Development workflow

| Task | Command |
| ---- | ------- |
| Type-check | `npm run typecheck` |
| Lint | `npm run lint` |
| Auto-format | `npm run format` |
| Run tests (SQLite + coverage gate) | `npm test` |
| Run tests without coverage | `npm run quick:test` |
| Run the full DB matrix | `SKIP_DOCKER_TESTS=0 npm run quick:test` (Docker required) |
| SQLite-only run (skip Docker) | `SKIP_DOCKER_TESTS=1 npm test` |
| Build the package | `npm run build` |
| Verify built exports resolve | `npm run verify:exports` |
| Benchmarks | `npm run bench` (or `BENCH_DB=postgres npm run bench`) |

`npm test` and `npm run build` both run lint first, so a clean `npm test` is a good pre-push check.

### Testing against databases

By default tests run against SQLite. Postgres and MySQL integration tests use [Testcontainers](https://testcontainers.com/) and require a running Docker daemon. Set `SKIP_DOCKER_TESTS=1` to skip them (this is what CI uses for the cross-platform unit job).

### Trying changes in a real app

The runnable demo under [`examples/demo`](./examples/demo) consumes the locally built package. After `npm run build` at the repo root, follow the demo's README to exercise the mixin, middleware, and `audit:verify` end to end.

## Coding conventions

- **Language**: TypeScript, ESM only.
- **Formatting**: Prettier via `@adonisjs/prettier-config`. Run `npm run format` before committing.
- **Linting**: ESLint via `@adonisjs/eslint-config`. CI fails on lint errors.
- **Coverage**: The suite enforces a coverage gate (see `c8` config in `package.json`). New code should keep coverage at or above the current thresholds.
- **Public API**: Anything added to `exports` in `package.json` is covered by `verify:exports`. Keep entry points minimal and intentional.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) — the changelog and releases are generated from them. Use the form:

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `ci`. Examples:

```
feat(stores): add Redis stream store
fix(http): bound retained verify log
docs: clarify guarantee modes
```

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Make your change with tests and docs where applicable.
3. Ensure `npm test` and `npm run typecheck` pass.
4. Open a PR using the template, linking any related issue.

PRs are reviewed via the GitHub Actions checks defined in [`.github/workflows/checks.yml`](./.github/workflows/checks.yml): lint, type-check, cross-platform unit tests, the DB integration matrix, and an end-to-end `configure` smoke test. All must pass before merge.

## Releases

Releases are cut by maintainers with `npm run release` ([release-it](https://github.com/release-it/release-it) + conventional changelog). Contributors do not need to bump versions or edit `CHANGELOG.md` manually — it is generated from commit history.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE.md).
