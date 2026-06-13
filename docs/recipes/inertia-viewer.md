# Recipe: Inertia audit viewer

Render a paginated audit trail in an AdonisJS + Inertia + React/Vue app using the shipped transformer.

## 1. Publish the transformer

`node ace configure` already created `app/transformers/audit_transformer.ts`.

```ts
import { BaseTransformer } from '@adonisjs/core/http'
import Audit from '@rikology/adonisjs-audit-trail/models/audit'

export default class AuditTransformer extends BaseTransformer {
  static model = Audit

  transform(audit: Audit) {
    return {
      id: audit.id,
      event: audit.event,
      actor: {
        type: audit.actorType,
        id: audit.actorId,
        label: audit.actorLabel,
      },
      diff: this.humanizeDiff(audit.oldValues, audit.newValues),
      createdAt: audit.createdAt,
    }
  }

  private humanizeDiff(oldValues: any, newValues: any) {
    // Build a simple key-by-key presentation
    const keys = new Set([...Object.keys(oldValues || {}), ...Object.keys(newValues || {})])
    return Array.from(keys).map((key) => ({
      field: key,
      before: oldValues?.[key] ?? null,
      after: newValues?.[key] ?? null,
    }))
  }
}
```

## 2. Controller

```ts
import type { HttpContext } from '@adonisjs/core/http'
import Audit from '@rikology/adonisjs-audit-trail/models/audit'
import AuditTransformer from '#transformers/audit_transformer'

export default class AuditsController {
  async index({ request, inertia }: HttpContext) {
    const page = request.input('page', 1)
    const audits = await Audit.query()
      .forModel(request.input('type'), request.input('id'))
      .orderBy('seq', 'desc')
      .paginate(page, 25)

    return inertia.render('audits/index', {
      audits: AuditTransformer.toPaginatedJSON(audits),
    })
  }
}
```

## 3. React page

```tsx
import { Head } from '@inertiajs/react'

export default function AuditsIndex({ audits }: { audits: any }) {
  return (
    <>
      <Head title="Audit trail" />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {audits.data.map((audit: any) => (
            <tr key={audit.id}>
              <td>{audit.createdAt}</td>
              <td>{audit.event}</td>
              <td>{audit.actor.label ?? audit.actor.id ?? audit.actor.type}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

## 4. Permission gate

Audit reads are sensitive. Gate the controller with Bouncer:

```ts
await bouncer.authorize('viewAudits', resource)
```

You can also emit an `audit.viewed` event when reading trails by calling `audit.log('audit.viewed').on(...)` after authorization.
