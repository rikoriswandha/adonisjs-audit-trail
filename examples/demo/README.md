# Audit trail demo

A minimal AdonisJS v7 API wired with `@rikology/adonisjs-audit-trail`. It demonstrates the `Auditable` mixin, automatic create/update capture, the request-context middleware, an explicit domain event, field redaction (`iban`), and tamper-evidence verification.

## Run

```bash
# from the repository root, build the local package consumed by the demo
npm install
npm run build

cd examples/demo
npm install
node ace migration:run
node ace serve --watch

# in another shell:
curl -X POST http://localhost:3333/demo/invoices/1/approve
node ace audit:verify
```

`audit:verify` exits non-zero if the hash chain is broken. The `iban` field is redacted in the stored audit record.
