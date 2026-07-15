import type { AuditActor } from '../types.js'
import type AuditService from '../services/audit.js'

type UnsubscribeFunction = () => void

type Listener = (payload: unknown) => void | Promise<void>

interface AuthEmitter {
  on(event: string, listener: Listener): UnsubscribeFunction
}

interface AuthPayload {
  guardName?: string
  user?: unknown
  error?: unknown
  sessionId?: string
  ctx?: {
    request?: {
      input?: (key: string) => unknown
    }
  }
}

const AUTH_EVENTS = {
  loginSucceeded: 'session_auth:login_succeeded',
  authFailed: 'session_auth:authentication_failed',
  loggedOut: 'session_auth:logged_out',
  accessTokenSucceeded: 'access_tokens_auth:authentication_succeeded',
  accessTokenFailed: 'access_tokens_auth:authentication_failed',
  basicSucceeded: 'basic_auth:authentication_succeeded',
  basicFailed: 'basic_auth:authentication_failed',
} as const

export default class AuthListener {
  #unsubscribers: UnsubscribeFunction[] = []

  constructor(
    protected emitter: AuthEmitter,
    protected audit: AuditService
  ) {}

  attach(): void {
    if (this.#unsubscribers.length > 0) return

    this.#unsubscribers.push(
      this.emitter.on(AUTH_EVENTS.loginSucceeded, (payload) => this.#loginSucceeded(payload)),
      this.emitter.on(AUTH_EVENTS.loggedOut, (payload) => this.#loggedOut(payload)),
      this.emitter.on(AUTH_EVENTS.authFailed, (payload) =>
        this.#failed(payload, 'auth.login_failed')
      ),
      this.emitter.on(AUTH_EVENTS.accessTokenSucceeded, (payload) =>
        this.#authenticated(payload, 'auth.access_token_authenticated')
      ),
      this.emitter.on(AUTH_EVENTS.accessTokenFailed, (payload) =>
        this.#failed(payload, 'auth.access_token_failed')
      ),
      this.emitter.on(AUTH_EVENTS.basicSucceeded, (payload) =>
        this.#authenticated(payload, 'auth.basic_authenticated')
      ),
      this.emitter.on(AUTH_EVENTS.basicFailed, (payload) =>
        this.#failed(payload, 'auth.basic_failed')
      )
    )
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      unsubscribe()
    }
  }

  async #loginSucceeded(payload: unknown): Promise<void> {
    const data = normalizePayload(payload)
    await this.audit
      .log('auth.login', 'auth')
      .by(actorFromUser(data.user))
      .withMeta(metadataFromPayload(data))
      .commit()
  }

  async #authenticated(payload: unknown, event: string): Promise<void> {
    const data = normalizePayload(payload)
    await this.audit
      .log(event, 'auth')
      .by(actorFromUser(data.user))
      .withMeta(metadataFromPayload(data))
      .commit()
  }

  async #loggedOut(payload: unknown): Promise<void> {
    const data = normalizePayload(payload)
    await this.audit
      .log('auth.logout', 'auth')
      .by(
        data.user === undefined || data.user === null
          ? { type: 'user', id: null }
          : actorFromUser(data.user)
      )
      .withMeta(metadataFromPayload(data))
      .commit()
  }

  async #failed(payload: unknown, event: string): Promise<void> {
    const data = normalizePayload(payload)
    const attempted =
      data.ctx?.request?.input?.('email') ?? data.ctx?.request?.input?.('uid') ?? null
    await this.audit
      .log(event, 'auth')
      .withMeta({
        ...metadataFromPayload(data),
        attemptedIdentifier: attempted,
        error: errorMessage(data.error),
      })
      .commit()
  }
}

function normalizePayload(payload: unknown): AuthPayload {
  if (payload === null || typeof payload !== 'object') return {}
  return payload as AuthPayload
}

function actorFromUser(user: unknown): AuditActor {
  const record = isRecord(user) ? user : {}
  const id = record.id ?? record.$primaryKeyValue ?? null
  const label = record.email ?? record.name ?? null
  return {
    type: 'user',
    id: id === null || id === undefined ? null : String(id),
    label: label === null || label === undefined ? null : String(label),
  }
}

function metadataFromPayload(payload: AuthPayload): Record<string, unknown> {
  return {
    guardName: payload.guardName ?? null,
    sessionId: payload.sessionId ?? null,
  }
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
