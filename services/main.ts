import app from '@adonisjs/core/services/app'
import type AuditService from '../src/services/audit.js'

let audit: AuditService

await app.booted(async () => {
  audit = await app.container.make('audit')
})

export { audit as default }
export type { AuditService as AuditService }
