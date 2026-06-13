import type { HttpContext } from '@adonisjs/core/http'
import type { ApplicationService } from '@adonisjs/core/types'
import type { NextFn } from '@adonisjs/http-server/types'
import { auditContext } from '../audit_context.js'
import type { AuditActor } from '../types.js'
import app from '@adonisjs/core/services/app'

interface AuthContext {
  auth: {
    authenticate(): Promise<unknown>
    user?: AuditUser | null
  }
}

interface AuditUser {
  id?: string | number | null
  email?: string | null
  username?: string | null
}

function hasAuth(ctx: HttpContext): ctx is HttpContext & AuthContext {
  return 'auth' in ctx
}

async function resolveActorFromAuth(ctx: HttpContext): Promise<AuditActor> {
  if (!hasAuth(ctx)) {
    return { type: 'system', id: null }
  }

  try {
    await ctx.auth.authenticate()
    const user = ctx.auth.user
    if (user) {
      return {
        type: 'user',
        id: String(user.id ?? null),
        label: user.email ?? user.username ?? null,
      }
    }
  } catch {
    // guest / unauthenticated
  }
  return { type: 'system', id: null }
}

export default class AuditContextMiddleware {
  #app?: ApplicationService

  constructor(...args: [ApplicationService?]) {
    this.#app = args[0]
  }

  async handle(ctx: HttpContext, next: NextFn) {
    const config = await (this.#app ?? app).container.make('audit.config')
    const tenantId = (await config.tenantResolver?.(ctx)) ?? undefined

    return auditContext.run(
      {
        requestId: ctx.request.id(),
        ip: ctx.request.ip(),
        userAgent: ctx.request.header('user-agent')?.slice(0, 512),
        url: ctx.request.url(true).slice(0, 2048),
        httpMethod: ctx.request.method(),
        correlationId: ctx.request.header('x-correlation-id') ?? ctx.request.id(),
        actor: async () => resolveActorFromAuth(ctx),
        tenantId,
      },
      () => next()
    )
  }
}
