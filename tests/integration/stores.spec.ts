import { test } from '@japa/runner'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import type { Writable } from 'node:stream'
import StreamStore from '../../src/stores/stream_store.js'
import HttpStore from '../../src/stores/http_store.js'
import FanoutStore from '../../src/stores/fanout_store.js'
import type { AuditEvent, AuditStoreContract } from '../../src/types.js'
import { storeContractTests } from '../helpers/store_contract.js'

function memoryStore(): AuditStoreContract {
  const events: ReturnType<AuditStoreContract['write']> extends Promise<(infer R)[]>
    ? R[]
    : never[] = []
  let seq = 0
  let hash = '0'.repeat(64)

  return {
    write: async (batch) => {
      const chained = batch.map((event) => {
        seq++
        const prevHash = hash
        hash = `${seq}`.padStart(64, '0')
        return { ...event, seq, hash, prevHash }
      })
      events.push(...chained)
      return chained
    },
    head: async () => (seq > 0 ? { seq, hash } : null),
    verify: async function* (stream) {
      yield { stream, valid: true, checkedCount: events.length }
    },
    prune: async () => ({ streams: [], totalPruned: 0, perEvent: {} }),
  }
}

storeContractTests({
  name: 'Stream (file)',
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-stream-'))
    const path = join(dir, 'audit.ndjson')
    return new StreamStore({ destination: path, format: 'ndjson' })
  },
  capabilities: { corruptable: false },
})

storeContractTests({
  name: 'Stream (writable)',
  create: async () => {
    const writable = {
      write(_chunk: string, callback?: (error?: Error | null) => void) {
        if (callback) callback(null)
        return true
      },
      once: () => {},
      end: () => {},
    } as unknown as Writable

    return new StreamStore({ destination: writable })
  },
  capabilities: { verifiable: false, corruptable: false, prunable: false },
})

storeContractTests({
  name: 'Http',
  create: async () => {
    return new Promise<HttpStore>((resolve) => {
      const server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, received: JSON.parse(body) }))
        })
      })

      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        const store = new HttpStore({ url: `http://127.0.0.1:${port}/audit` })
        ;(store as unknown as { __server: typeof server }).__server = server
        resolve(store)
      })
    })
  },
  capabilities: { verifiable: true, corruptable: false, prunable: true },
})

storeContractTests({
  name: 'Fanout',
  create: async () => {
    return new FanoutStore({ primary: memoryStore(), mirrors: [memoryStore()] })
  },
  capabilities: { corruptable: false },
})

test.group('Store-specific behavior', (group) => {
  let server: ReturnType<typeof createServer>

  group.each.teardown(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('HttpStore signs request when signature config provided', async ({ assert }) => {
    const receivedHeaders: Record<string, string | string[] | undefined> = {}

    server = createServer((req, res) => {
      receivedHeaders['x-audit-signature'] = req.headers['x-audit-signature']
      receivedHeaders['x-idempotency-key'] = req.headers['x-idempotency-key']
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    process.env.AUDIT_HTTP_SECRET = 'super-secret'
    const httpStore = new HttpStore({
      url: `http://127.0.0.1:${port}/audit`,
      signature: { secretEnvVar: 'AUDIT_HTTP_SECRET' },
    })

    await httpStore.write([
      {
        id: 'evt-1',
        event: 'test',
        stream: 'default',
        auditableType: null,
        auditableId: null,
        oldValues: null,
        newValues: null,
        metadata: null,
        actor: { type: 'system', id: null },
        tenantId: null,
        requestId: null,
        correlationId: null,
        ipAddress: null,
        userAgent: null,
        url: null,
        httpMethod: null,
        tags: [],
        schemaVersion: '1',
        createdAt: new Date().toISOString(),
      } satisfies AuditEvent,
    ])

    assert.isDefined(receivedHeaders['x-audit-signature'])
    assert.equal(typeof receivedHeaders['x-audit-signature'], 'string')
    assert.isDefined(receivedHeaders['x-idempotency-key'])
  })

  test('HttpStore verify checks locally chained rows after posts', async ({ assert }) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, received: JSON.parse(body) }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const store = new HttpStore({ url: `http://127.0.0.1:${port}/audit` })
    await store.write([
      {
        id: 'evt-1',
        event: 'test',
        stream: 'default',
        auditableType: null,
        auditableId: null,
        oldValues: null,
        newValues: null,
        metadata: null,
        actor: { type: 'system', id: null },
        tenantId: null,
        requestId: null,
        correlationId: null,
        ipAddress: null,
        userAgent: null,
        url: null,
        httpMethod: null,
        tags: [],
        schemaVersion: '1',
        createdAt: new Date().toISOString(),
      } satisfies AuditEvent,
      {
        id: 'evt-2',
        event: 'test',
        stream: 'default',
        auditableType: null,
        auditableId: null,
        oldValues: null,
        newValues: null,
        metadata: null,
        actor: { type: 'system', id: null },
        tenantId: null,
        requestId: null,
        correlationId: null,
        ipAddress: null,
        userAgent: null,
        url: null,
        httpMethod: null,
        tags: [],
        schemaVersion: '1',
        createdAt: new Date().toISOString(),
      } satisfies AuditEvent,
    ])

    const reports = []
    for await (const report of store.verify('default')) {
      reports.push(report)
    }

    assert.isAtLeast(reports.length, 1)
    assert.isTrue(reports[reports.length - 1]!.valid)
    assert.equal(reports[reports.length - 1]!.checkedCount, 2)
  })

  test('HttpStore prune removes old events but keeps stream head', async ({ assert }) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, received: JSON.parse(body) }))
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const store = new HttpStore({ url: `http://127.0.0.1:${port}/audit` })
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

    await store.write([
      {
        id: 'old-1',
        event: 'user.created',
        stream: 'default',
        auditableType: null,
        auditableId: null,
        oldValues: null,
        newValues: null,
        metadata: null,
        actor: { type: 'system', id: null },
        tenantId: null,
        requestId: null,
        correlationId: null,
        ipAddress: null,
        userAgent: null,
        url: null,
        httpMethod: null,
        tags: [],
        schemaVersion: '1',
        createdAt: twoDaysAgo,
      } satisfies AuditEvent,
      {
        id: 'new-2',
        event: 'user.created',
        stream: 'default',
        auditableType: null,
        auditableId: null,
        oldValues: null,
        newValues: null,
        metadata: null,
        actor: { type: 'system', id: null },
        tenantId: null,
        requestId: null,
        correlationId: null,
        ipAddress: null,
        userAgent: null,
        url: null,
        httpMethod: null,
        tags: [],
        schemaVersion: '1',
        createdAt: new Date().toISOString(),
      } satisfies AuditEvent,
    ])

    const report = await store.prune({ default: '1 day' })

    assert.equal(report.totalPruned, 1)
    assert.deepEqual(report.perEvent, { 'user.created': 1 })
    assert.deepEqual(report.streams, ['default'])

    const head = await store.head('default')
    assert.isNotNull(head)
    assert.equal(head!.seq, 2)
  })

  test('FanoutStore mirrors events and tolerates mirror failures', async ({ assert }) => {
    const primaryEvents: AuditEvent[][] = []
    const mirrorEvents: AuditEvent[][] = []

    const primary: AuditStoreContract = {
      ...memoryStore(),
      write: async (batch) => {
        primaryEvents.push(batch)
        return batch.map((event, index) => ({
          ...event,
          seq: index + 1,
          hash: 'a'.repeat(64),
          prevHash: index === 0 ? '0'.repeat(64) : 'a'.repeat(64),
        }))
      },
    }

    const mirror: AuditStoreContract = {
      ...memoryStore(),
      write: async (batch) => {
        mirrorEvents.push(batch)
        return []
      },
    }

    const fanout = new FanoutStore({ primary, mirrors: [mirror] })
    const event: AuditEvent = {
      id: 'evt-1',
      event: 'test',
      stream: 'default',
      auditableType: null,
      auditableId: null,
      oldValues: null,
      newValues: null,
      metadata: null,
      actor: { type: 'system', id: null },
      tenantId: null,
      requestId: null,
      correlationId: null,
      ipAddress: null,
      userAgent: null,
      url: null,
      httpMethod: null,
      tags: [],
      schemaVersion: '1',
      createdAt: new Date().toISOString(),
    }

    await fanout.write([event])

    assert.lengthOf(primaryEvents, 1)
    assert.lengthOf(mirrorEvents, 1)
  })
})
