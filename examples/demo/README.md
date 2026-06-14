# Audit trail demo

A minimal AdonisJS v7 API wired with `@rikology/adonisjs-audit-trail`. It demonstrates the `Auditable` mixin, automatic create/update capture, the request-context middleware, an explicit domain event, field redaction (`iban`), and tamper-evidence verification.

## Prerequisites

- Node.js `>= 24`
- The package built at the repository root (`npm run build`)

## Run

```bash
# from the repository root, build the local package consumed by the demo
npm install
npm run build

cd examples/demo
npm install
node ace migration:run
node ace serve --watch
```

## Try it

```bash
# Create and approve an invoice
curl -X POST http://localhost:3333/demo/invoices \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"iban":"NL91ABNA0417164300"}'

curl -X POST http://localhost:3333/demo/invoices/1/approve

# Verify the hash chain
node ace audit:verify
```

`audit:verify` exits non-zero if the hash chain is broken. The `iban` field is redacted in the stored audit record.
