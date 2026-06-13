import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/http-server/types'
import { auditContext } from '../audit_context.js'

export default class AuditContextMiddleware {
  async handle(_ctx: HttpContext, next: NextFn) {
    return auditContext.run({}, () => next())
  }
}
