import { defineConfig, stores } from '@rikology/adonisjs-audit-trail'

export default defineConfig({
  /**
   * Default store used by the audit pipeline.
   */
  default: 'lucid',

  /**
   * Delivery guarantee mode.
   * - 'best-effort': enqueue and flush asynchronously (default, fastest)
   * - 'request-coupled': hold the response until the audit is durably written
   * - 'transactional-outbox': write to an outbox table inside the business transaction
   */
  guarantee: 'best-effort',

  /**
   * Configured stores. The lucid store requires @adonisjs/lucid.
   */
  stores: {
    lucid: stores.lucid({
      table: 'audits',
      enforceImmutability: true,
      // connection: 'audit', // Optional: use a dedicated audit DB connection.
    }),
  },

  /**
   * PII / sensitive field redaction.
   */
  redaction: {
    global: ['password', 'passwordConfirmation', 'token', 'secret', '*.secret'],
    mode: 'mask', // 'mask' | 'remove' | 'hash'
    saltEnvVar: 'AUDIT_REDACTION_SALT',
  },

  /**
   * Retention policies used by "node ace audit:prune".
   */
  retention: {
    default: '730 days',
    perEvent: {
      'auth.login': '90 days',
      'auth.login_failed': '30 days',
    },
    // archive: async (segment) => { /* push NDJSON to object storage */ },
  },

  /**
   * Hash-chain configuration.
   */
  chain: {
    enabled: true,
    streamBy: 'global',
  },

  /**
   * In-memory queue / flush settings.
   */
  queue: {
    maxBatchSize: 200,
    flushIntervalMs: 250,
    capacity: 10_000,
    overflow: 'dropOldest', // 'dropOldest' | 'dropNew' | 'block'
  },

  /**
   * Max payload size for old/new values and metadata.
   */
  payloadMaxBytes: 32_768,

  /**
   * Automatically capture auth login/logout events.
   */
  captureAuthEvents: true,
})
