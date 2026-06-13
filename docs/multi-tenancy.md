# Multi-tenancy

The library supports tenant-scoped audit streams out of the box.

## Enabling tenant scoping

At configure time, answer **yes** to the multi-tenant prompt, or set:

```ts
chain: {
  streamBy: 'tenant',
}
```

Provide a tenant resolver in `config/audit.ts`:

```ts
export default defineConfig({
  tenantResolver: async (ctx) => {
    return ctx.auth.user?.tenantId ?? null
  },
})
```

The middleware captures the tenant for every HTTP request. For jobs or CLI commands, use `audit.withinContext`:

```ts
import audit from '@rikology/adonisjs-audit-trail/services/main'

await audit.withinContext({ tenantId: 'acme' }, async () => {
  await invoice.save()
})
```

## Tenant-scoped queries

```ts
import Audit from '@rikology/adonisjs-audit-trail/models/audit'

const trail = await Audit.inTenant('acme').orderBy('seq', 'desc').paginate(1, 20)
```

## Tenant-scoped chains

When `streamBy: 'tenant'`, each tenant has its own hash chain (`tenant:acme`). Verification still works per stream; an attacker tampering with one tenant cannot affect another tenant's chain.

## Mixed tenancy

You can also supply a custom stream function:

```ts
chain: {
  streamBy: (event) => `tenant:${event.tenantId}:event:${event.event.split('.')[0]}`,
}
```

Keep stream identifiers stable and under 64 characters.
