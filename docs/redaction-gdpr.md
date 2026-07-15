# Redaction & GDPR

Audit trails must not leak secrets. The library redacts values **before** they enter the hash chain.

## Redaction modes

| Mode | Effect | Stored value |
| ---- | ------ | ------------ |
| `mask` | Replace with `'[REDACTED]'` | `'[REDACTED]'` |
| `remove` | Drop the key entirely | key absent |
| `hash` | Store `sha256(salt + value)` | `'sha256:...'` |

Hash mode is useful when you need to know that a value changed without storing the value itself. It requires `AUDIT_REDACTION_SALT`.

## Configuring paths

```ts
redaction: {
  global: ['password', 'token', '*.secret', 'card.*'],
  mode: 'mask',
}
```

Supported matchers:

- Exact key: `password`
- Deep wildcard: `*.secret` matches `auth.secret`, `nested.api.secret`, etc.
- Prefix wildcard: `card.*` matches `card.number`, `card.cvv`, etc.

Model-level config can add extra redactions:

```ts
static auditConfig = {
  redact: ['iban', 'ssn'],
}
```

## Crypto-shredding (experimental)

For GDPR right-to-erasure, sensitive values can be encrypted with a per-subject key. Erasure deletes the key; the ciphertext remains in the audit table, so the hash chain stays valid.

```bash
node ace audit:forget --subject=user-123
```

Configure a `SubjectKeyStore` in `config/audit.ts`:

```ts
import { defineConfig, MemorySubjectKeyStore, stores } from '@rikology/adonisjs-audit-trail'

const keyStore = new MemorySubjectKeyStore()

export default defineConfig({
  stores: { lucid: stores.lucid() },
  cryptoShredding: {
    enabled: true,
    fields: ['old_values.email', 'new_values.email'],
    keyStore,
  },
})
```

`MemorySubjectKeyStore` is useful for development and tests. Production deployments must provide a durable `SubjectKeyStore` implementation (or construct `LucidSubjectKeyStore` with the application service).

Use `node ace audit:forget --subject=<id>` to delete a subject key.

## Design note: redaction happens before hashing

Because redacted values are what get hashed, two identical sensitive values produce identical hashes, and the chain remains deterministic. Never backfill raw values into redacted fields; doing so would break the chain.
