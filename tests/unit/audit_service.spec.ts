import { test } from '@japa/runner'
import { AuditDroppedError } from '../../src/core/errors.js'
import AuditService from '../../src/services/audit.js'
import type AuditPipeline from '../../src/core/pipeline.js'
import type StoreManager from '../../src/stores/store_manager.js'
import { auditContext } from '../../src/audit_context.js'

function createFakePipeline(enqueueReturns: boolean): AuditPipeline {
  return {
    enqueue: () => enqueueReturns,
    requestCoupledFlush: async () => {},
    stats: () => ({
      queued: 0,
      written: 0,
      dropped: 0,
      retried: 0,
      deadLettered: 0,
      lastFlushAt: null,
    }),
    // cast from a plain object to the typed pipeline for unit isolation
  } as unknown as AuditPipeline
}

function createFakeManager(): StoreManager {
  return {
    // cast from a plain object to the typed manager for unit isolation
  } as unknown as StoreManager
}

test.group('AuditService', () => {
  test('emitLogSync throws typed error when enqueue rejects event', async ({ assert }) => {
    const service = new AuditService(createFakeManager(), createFakePipeline(false), {
      assemble: { payloadMaxBytes: 32_768, streamBy: 'global' },
      context: auditContext,
      guarantee: 'request-coupled',
    })

    try {
      await auditContext.run({}, () => service.log('user.login').commitSync())
      assert.fail('expected emitLogSync to throw')
    } catch (error) {
      assert.instanceOf(error, AuditDroppedError)
      assert.equal((error as AuditDroppedError).code, 'E_AUDIT_DROPPED')
    }
  })

  test('emitLog throws typed error for strict guarantees when enqueue rejects event', async ({
    assert,
  }) => {
    const service = new AuditService(createFakeManager(), createFakePipeline(false), {
      assemble: { payloadMaxBytes: 32_768, streamBy: 'global' },
      context: auditContext,
      guarantee: 'request-coupled',
    })

    try {
      await auditContext.run({}, () => service.log('user.login').commit())
      assert.fail('expected emitLog to throw')
    } catch (error) {
      assert.instanceOf(error, AuditDroppedError)
      assert.equal((error as AuditDroppedError).code, 'E_AUDIT_DROPPED')
    }
  })

  test('emitLog does not throw for best-effort when enqueue rejects event', async ({ assert }) => {
    const service = new AuditService(createFakeManager(), createFakePipeline(false), {
      assemble: { payloadMaxBytes: 32_768, streamBy: 'global' },
      context: auditContext,
      guarantee: 'best-effort',
    })

    await assert.doesNotReject(async () => {
      await auditContext.run({}, () => service.log('user.login').commit())
    })
  })

  test('emitLog awaits coupled flush when enqueue succeeds in request-coupled mode', async ({
    assert,
  }) => {
    let flushedIds: string[] | undefined
    const pipeline = createFakePipeline(true)
    pipeline.requestCoupledFlush = async (ids) => {
      flushedIds = ids
    }

    const service = new AuditService(createFakeManager(), pipeline, {
      assemble: { payloadMaxBytes: 32_768, streamBy: 'global' },
      context: auditContext,
      guarantee: 'request-coupled',
    })

    await auditContext.run({}, () => service.log('user.login').commit())

    assert.isDefined(flushedIds)
    assert.lengthOf(flushedIds!, 1)
  })
})
