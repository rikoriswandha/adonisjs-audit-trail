import { randomBytes } from 'node:crypto'
import { Encryption } from '@adonisjs/core/encryption'
import { AES256GCM } from '@adonisjs/core/encryption/drivers/aes_256_gcm'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { ApplicationService } from '@adonisjs/core/types'
import type { AuditEvent, CryptoShreddingConfig, SubjectKeyStore } from '../types.js'
import { canonicalJson } from './canonical_json.js'
import { AuditConfigurationError } from './errors.js'

const ENCRYPTED_MARKER = '_encrypted'
const CIPHERTEXT_KEY = 'ciphertext'

export class MemorySubjectKeyStore implements SubjectKeyStore {
  readonly #keys = new Map<string, string>()

  async get(subjectId: string, _client?: TransactionClientContract): Promise<string | null> {
    return this.#keys.get(subjectId) ?? null
  }

  async set(subjectId: string, key: string, _client?: TransactionClientContract): Promise<void> {
    if (!this.#keys.has(subjectId)) {
      this.#keys.set(subjectId, key)
    }
  }

  async delete(subjectId: string, _client?: TransactionClientContract): Promise<void> {
    this.#keys.delete(subjectId)
  }
}

export class LucidSubjectKeyStore implements SubjectKeyStore {
  readonly #table: string
  readonly #connection?: string
  #app?: ApplicationService

  constructor(options: { table?: string; connection?: string; app?: ApplicationService } = {}) {
    this.#table = options.table ?? 'audit_subject_keys'
    this.#connection = options.connection
    this.#app = options.app
  }

  async get(subjectId: string, client?: TransactionClientContract): Promise<string | null> {
    const db = client ?? (await this.#db())
    const row = await db
      .query()
      .select('key')
      .from(this.#table)
      .where('subject_id', subjectId)
      .first()
    return row?.key ?? null
  }

  async set(subjectId: string, key: string, client?: TransactionClientContract): Promise<void> {
    const db = client ?? (await this.#db())
    await db
      .table(this.#table)
      .insert({ subject_id: subjectId, key })
      .onConflict('subject_id')
      .ignore()
  }

  async delete(subjectId: string, client?: TransactionClientContract): Promise<void> {
    const db = client ?? (await this.#db())
    await db.query().from(this.#table).where('subject_id', subjectId).delete()
  }

  async #db() {
    if (!this.#app) {
      throw new AuditConfigurationError('LucidSubjectKeyStore requires an application instance')
    }
    return this.#connection
      ? await this.#app.container.make(`lucid.${this.#connection}`)
      : await this.#app.container.make('lucid.db')
  }
}

export interface SubjectCryptoConfig {
  fields: string[]
  keyStore: SubjectKeyStore
  subjectResolver?: (event: AuditEvent) => string | null | Promise<string | null>
}

export class SubjectCrypto {
  readonly #config: SubjectCryptoConfig

  constructor(config: SubjectCryptoConfig) {
    this.#config = config
  }

  async encrypt(event: AuditEvent, client?: TransactionClientContract): Promise<AuditEvent> {
    const subjectId = await this.#resolveSubject(event)
    if (!subjectId) {
      return event
    }

    let key = await this.#config.keyStore.get(subjectId, client)
    if (!key) {
      await this.#config.keyStore.set(subjectId, this.#generateKey(), client)
      key = await this.#config.keyStore.get(subjectId, client)
      if (!key) {
        throw new AuditConfigurationError(`Subject key creation failed for "${subjectId}"`)
      }
    }

    const encryption = this.#createEncryption(key)

    return {
      ...event,
      oldValues: this.#transformValues(event.oldValues, encryption.encrypt.bind(encryption)),
      newValues: this.#transformValues(event.newValues, encryption.encrypt.bind(encryption)),
      metadata: this.#transformValues(event.metadata, encryption.encrypt.bind(encryption)),
    }
  }

  async decrypt(event: AuditEvent, client?: TransactionClientContract): Promise<AuditEvent> {
    const subjectId = await this.#resolveSubject(event)
    if (!subjectId) {
      return event
    }

    const key = await this.#config.keyStore.get(subjectId, client)
    if (!key) {
      return {
        ...event,
        oldValues: this.#markForgotten(event.oldValues),
        newValues: this.#markForgotten(event.newValues),
        metadata: this.#markForgotten(event.metadata),
      }
    }

    const encryption = this.#createEncryption(key)
    const decrypt = (value: unknown) => encryption.decrypt(value as string)

    return {
      ...event,
      oldValues: this.#transformValues(event.oldValues, decrypt, true),
      newValues: this.#transformValues(event.newValues, decrypt, true),
      metadata: this.#transformValues(event.metadata, decrypt, true),
    }
  }

  async #resolveSubject(event: AuditEvent): Promise<string | null> {
    if (this.#config.subjectResolver) {
      return await this.#config.subjectResolver(event)
    }

    if (!event.actor.id) {
      return null
    }

    return canonicalJson(['audit-subject', event.tenantId, event.actor.type, event.actor.id])
  }

  #generateKey(): string {
    return randomBytes(32).toString('hex')
  }

  #createEncryption(key: string): Encryption {
    return new Encryption({
      driver: (k) => new AES256GCM({ id: 'audit-subject', key: k }),
      keys: [key],
    })
  }

  #transformValues(
    values: Record<string, unknown> | null,
    transform: (value: unknown) => unknown,
    decrypt = false
  ): Record<string, unknown> | null {
    if (!values) {
      return values
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (this.#config.fields.includes(key)) {
        result[key] = decrypt
          ? this.#decryptValue(value, transform as (value: string) => unknown)
          : this.#encryptValue(value, transform)
      } else {
        result[key] = value
      }
    }
    return result
  }

  #encryptValue(value: unknown, encrypt: (value: unknown) => unknown): unknown {
    if (value === null || value === undefined) {
      return value
    }
    return { [ENCRYPTED_MARKER]: true, [CIPHERTEXT_KEY]: encrypt(value) }
  }

  #decryptValue(value: unknown, decrypt: (value: string) => unknown): unknown {
    if (typeof value !== 'object' || value === null || !(ENCRYPTED_MARKER in value)) {
      return value
    }

    const ciphertext = (value as Record<string, unknown>)[CIPHERTEXT_KEY]
    if (typeof ciphertext !== 'string') {
      return value
    }

    return decrypt(ciphertext)
  }

  #markForgotten(values: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!values) {
      return values
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (this.#config.fields.includes(key)) {
        result[key] =
          typeof value === 'object' && value !== null && ENCRYPTED_MARKER in value
            ? { [ENCRYPTED_MARKER]: true, _forgotten: true }
            : value
      } else {
        result[key] = value
      }
    }
    return result
  }
}

export function createSubjectCrypto(config?: CryptoShreddingConfig): SubjectCrypto | undefined {
  if (!config || !config.enabled) {
    return undefined
  }

  return new SubjectCrypto({
    fields: config.fields,
    keyStore: config.keyStore,
    subjectResolver: config.subjectResolver,
  })
}
