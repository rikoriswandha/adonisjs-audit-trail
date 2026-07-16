import { test } from '@japa/runner'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AuditDroppedError, AuditTransactionRequiredError } from '../../src/core/errors.js'
import AuditService from '../../src/services/audit.js'
import type AuditPipeline from '../../src/core/pipeline.js'
import type StoreManager from '../../src/stores/store_manager.js'
import { auditContext } from '../../src/audit_context.js'

type ReportedError = { event: string; source: string }

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

interface InsertedOutboxRow {
  table: string
  payload: {
    id?: string
    payload?: string
    status?: string
    attempts?: number
  }
}

function createTransaction(inserted: InsertedOutboxRow[]): TransactionClientContract {
  return {
    insertQuery() {
      return {
        table(table: string) {
          return {
            async insert(payload: Record<string, unknown>) {
              inserted.push({
                table,
                payload: payload as InsertedOutboxRow['payload'],
              })
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

  test('transactional-outbox events allocate distinct UUIDv7 row identities', async ({
    assert,
  }) => {
    const inserted: InsertedOutboxRow[] = []
    const service = createService('transactional-outbox', createFakePipeline(true))
    const transaction = createTransaction(inserted)

    await auditContext.run({}, async () => {
      await service.log('user.login').withTransaction(transaction).commit()
      await service.log('user.login').withTransaction(transaction).commit()
    })

    assert.lengthOf(inserted, 2)
    assert.equal(inserted[0].table, 'audit_outbox')
    assert.equal(inserted[0].payload.status, 'pending')
    assert.equal(inserted[0].payload.attempts, 0)

    const rowIds = inserted.map((row) => String(row.payload.id))
    assert.match(rowIds[0], uuidV7Pattern)
    assert.match(rowIds[1], uuidV7Pattern)
    assert.notEqual(rowIds[0], rowIds[1])

    for (const row of inserted) {
      const serializedEvent = JSON.parse(String(row.payload.payload)) as { event: { id: string } }
      assert.notEqual(row.payload.id, serializedEvent.event.id)
    }
  })
})
