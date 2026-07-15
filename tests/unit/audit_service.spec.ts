import { test } from '@japa/runner'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AuditDroppedError, AuditTransactionRequiredError } from '../../src/core/errors.js'
import AuditService from '../../src/services/audit.js'
import type AuditPipeline from '../../src/core/pipeline.js'
import type StoreManager from '../../src/stores/store_manager.js'
import { auditContext } from '../../src/audit_context.js'

type ReportedError = { event: string; source: string }

function createFakePipeline(enqueueReturns: boolean): AuditPipeline {
  return {
    enqueue: async () => enqueueReturns,
    requestCoupledFlush: async () => {},
    stats: () => ({
      queued: 0,
      written: 0,
      dropped: 0,
      retried: 0,
      deadLettered: 0,
      lastFlushAt: null,
    }),
  } as unknown as AuditPipeline
}

function createFakeManager(): StoreManager {
  return {} as StoreManager
}

function createService(
  guarantee: 'best-effort' | 'request-coupled' | 'transactional-outbox',
  pipeline: AuditPipeline,
  errors: ReportedError[] = []
): AuditService {
  return new AuditService(createFakeManager(), pipeline, {
    assemble: { payloadMaxBytes: 32_768, streamBy: 'global' },
    context: auditContext,
    guarantee,
    emitter: {
      async emit(event, payload) {
        if (
          event === 'audit:error' &&
          payload !== null &&
          typeof payload === 'object' &&
          'source' in payload &&
          typeof payload.source === 'string'
        ) {
          errors.push({ event, source: payload.source })
        }
      },
    },
  })
}

function createTransaction(inserted: {
  table?: string
  payload?: Record<string, unknown>
}): TransactionClientContract {
  return {
    insertQuery() {
      return {
        table(table: string) {
          inserted.table = table
          return {
            async insert(payload: Record<string, unknown>) {
              inserted.payload = payload
            },
          }
        },
      }
    },
  } as unknown as TransactionClientContract
}

test.group('AuditService delivery guarantees', () => {
  test('best-effort explicit events tolerate pipeline overflow', async ({ assert }) => {
    const service = createService('best-effort', createFakePipeline(false))

    await assert.doesNotReject(async () => {
      await auditContext.run({}, () => service.log('user.login').commit())
    })
  })

  test('request-coupled explicit events await target-store completion', async ({ assert }) => {
    let flushedIds: string[] | undefined
    const pipeline = createFakePipeline(true)
    pipeline.requestCoupledFlush = async (ids) => {
      flushedIds = ids
    }
    const service = createService('request-coupled', pipeline)

    await auditContext.run({}, () => service.log('user.login').commit())

    assert.lengthOf(flushedIds ?? [], 1)
  })

  test('request-coupled overflow surfaces a typed failure', async ({ assert }) => {
    const service = createService('request-coupled', createFakePipeline(false))

    await assert.rejects(
      () => auditContext.run({}, () => service.log('user.login').commit()),
      AuditDroppedError
    )
  })

  test('request-coupled store failure is reported and surfaced', async ({ assert }) => {
    const errors: ReportedError[] = []
    const pipeline = createFakePipeline(true)
    pipeline.requestCoupledFlush = async () => {
      throw new Error('target store unavailable')
    }
    const service = createService('request-coupled', pipeline, errors)

    await assert.rejects(
      () => auditContext.run({}, () => service.log('user.login').commit()),
      /target store unavailable/
    )

    assert.deepEqual(errors, [{ event: 'audit:error', source: 'domain' }])
  })

  test('transactional-outbox explicit events fail closed without caller transaction', async ({
    assert,
  }) => {
    const service = createService('transactional-outbox', createFakePipeline(true))

    await assert.rejects(
      () => auditContext.run({}, () => service.log('user.login').commit()),
      AuditTransactionRequiredError
    )
  })

  test('transactional-outbox explicit events write one intent on the supplied transaction', async ({
    assert,
  }) => {
    const inserted: { table?: string; payload?: Record<string, unknown> } = {}
    const service = createService('transactional-outbox', createFakePipeline(true))
    const transaction = createTransaction(inserted)

    await auditContext.run({}, () =>
      service.log('user.login').withTransaction(transaction).commit()
    )

    assert.equal(inserted.table, 'audit_outbox')
    assert.equal(inserted.payload?.status, 'pending')
    assert.equal(inserted.payload?.attempts, 0)
  })
})
