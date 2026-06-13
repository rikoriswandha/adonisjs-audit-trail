import '@rikology/adonisjs-audit-trail/types'

declare module '@rikology/adonisjs-audit-trail/types' {
  interface AuditEvents {
    'invoice.approved': true
  }
}
