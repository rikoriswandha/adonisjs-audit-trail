# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

If you discover a security issue in `@rikology/adonisjs-audit-trail`, please email **security@rikology.dev** with:

- A description of the vulnerability.
- Steps to reproduce (proof-of-concept code, config, or commands).
- The affected version(s).
- Any suggested remediation.

Please allow up to **72 hours** for an initial response. We will coordinate disclosure and release a fix as quickly as possible.

## Disclosure timeline

1. **Acknowledgment** — we confirm receipt within 72 hours.
2. **Investigation** — we validate and scope the issue, usually within 7 days.
3. **Fix & release** — we prepare a patch and coordinate disclosure. Critical fixes are released out-of-band.
4. **Public disclosure** — after a fix is available, we publish a security advisory and credit the reporter (with permission).

## Scope

Security reports should focus on the library itself:

- Hash-chain integrity failures
- Storage isolation bypasses
- Redaction bypasses
- Privilege escalation through audit commands
- Canonicalization or serialization weaknesses

General application security issues (e.g. weak DB credentials, missing app-level authorization) are out of scope.

## Security-related configuration

See the [threat model](./docs/threat-model.md) and [operations guide](./docs/operations.md) for hardening recommendations, including INSERT-only database grants and verification cron jobs.
