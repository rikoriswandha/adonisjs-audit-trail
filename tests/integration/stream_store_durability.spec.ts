import { test } from '@japa/runner'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import StreamStore from '../../src/stores/stream_store.js'
import type { AuditEvent, VerifyReport } from '../../src/types.js'

const STREAM = 'durability'

function event(id: number): AuditEvent {
  return {
    id: `evt-${id}`,
    event: 'user.created',
    stream: STREAM,
    auditableType: 'User',
    auditableId: String(id),
    oldValues: null,
    newValues: { name: `User ${id}` },
    metadata: null,
    actor: { type: 'system', id: null },
    tenantId: null,
    requestId: `request-${id}`,
    correlationId: `correlation-${id}`,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    url: 'http://localhost/users',
    httpMethod: 'POST',
    tags: [],
    schemaVersion: '1',
    createdAt: new Date(id).toISOString(),
  }
}

async function verifyReports(store: StreamStore): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = []
  for await (const report of store.verify(STREAM)) {
    reports.push(report)
  }
  return reports
}

test.group('StreamStore durability', (group) => {
  let dir: string

  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-stream-durability-'))
  })

  group.each.teardown(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reuses file stream writes and atomically persists sidecar heads', async ({ assert }) => {
    const path = join(dir, 'audit.ndjson')
    const sidecarPath = `${path}.head.json`
    const tmpSidecarPath = `${sidecarPath}.tmp`
    const store = new StreamStore({ destination: path, format: 'ndjson' })

    for (let batch = 0; batch < 20; batch++) {
      const offset = batch * 10
      await store.write(Array.from({ length: 10 }, (_, index) => event(offset + index + 1)))
    }

    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    assert.lengthOf(lines, 200)

    const parsed = lines.map((line) => JSON.parse(line))
    assert.lengthOf(parsed, 200)
    assert.equal(parsed[0].seq, 1)
    assert.equal(parsed[199].seq, 200)

    const reports = await verifyReports(store)
    assert.isAtLeast(reports.length, 1)
    assert.isTrue(reports[reports.length - 1]!.valid)
    assert.equal(reports[reports.length - 1]!.checkedCount, 200)

    assert.isTrue(existsSync(sidecarPath))
    assert.isFalse(existsSync(tmpSidecarPath))
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
    assert.equal(sidecar[STREAM].seq, 200)

    const restarted = new StreamStore({ destination: path, format: 'ndjson' })
    await restarted.write(Array.from({ length: 10 }, (_, index) => event(201 + index)))

    const restartedReports = await verifyReports(restarted)
    assert.isAtLeast(restartedReports.length, 1)
    assert.isTrue(restartedReports[restartedReports.length - 1]!.valid)
    assert.equal(restartedReports[restartedReports.length - 1]!.checkedCount, 210)
    assert.isFalse(existsSync(tmpSidecarPath))
  })
})
