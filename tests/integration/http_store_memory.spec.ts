import { test } from '@japa/runner'
import { createServer } from 'node:http'
import HttpStore from '../../src/stores/http_store.js'
import type { AuditEvent, VerifyReport } from '../../src/types.js'

const STREAM = 'http-memory'

function event(id: number): AuditEvent {
  return {
    id: `event-${id}`,
    event: 'user.created',
    stream: STREAM,
    auditableType: 'User',
    auditableId: `${id}`,
    oldValues: null,
    newValues: { id },
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
    createdAt: new Date(id).toISOString(),
  }
}

async function writeEvents(store: HttpStore, count: number): Promise<void> {
  for (let id = 1; id <= count; id += 2) {
    await store.write([event(id), event(id + 1)])
  }
}

async function collectReports(store: HttpStore): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = []

  for await (const report of store.verify(STREAM)) {
    reports.push(report)
  }

  return reports
}

test.group('HttpStore memory retention', (group) => {
  let server: ReturnType<typeof createServer> | undefined

  group.each.teardown(async () => {
    if (!server) return

    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  })

  async function createStore(maxRetainedPerStream: number): Promise<HttpStore> {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
    })

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    return new HttpStore({ url: `http://127.0.0.1:${port}/audit`, maxRetainedPerStream })
  }

  test('caps retained events per stream without breaking verification', async ({ assert }) => {
    const store = await createStore(5)

    await writeEvents(store, 20)
    const reports = await collectReports(store)

    assert.isAtLeast(reports.length, 1)
    assert.isTrue(reports.every((report) => report.valid))
    assert.isAtMost(reports[reports.length - 1]!.checkedCount, 5)
  })

  test('keeps unbounded retention when cap is zero', async ({ assert }) => {
    const store = await createStore(0)

    await writeEvents(store, 20)
    const reports = await collectReports(store)

    assert.isAtLeast(reports.length, 1)
    assert.isTrue(reports.every((report) => report.valid))
    assert.equal(reports[reports.length - 1]!.checkedCount, 20)
  })
})
