import { test } from '@japa/runner'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { AnchorService, fileAppendPublisher } from '../../src/core/anchor.js'
import type { ChainedAuditEvent } from '../../src/types.js'

function event(seq: number, stream: string = 'default'): ChainedAuditEvent {
  return {
    id: `evt-${seq}`,
    event: 'test',
    stream,
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
    seq,
    hash: `${seq}`.padStart(64, '0'),
    prevHash: `${seq - 1}`.padStart(64, '0'),
  }
}

test.group('AnchorService', (group) => {
  let dir: string

  group.each.setup(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-anchor-'))
  })

  group.each.teardown(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('publishes anchor every N events', async ({ assert }) => {
    const anchorsFile = join(dir, 'anchors.ndjson')
    const publish = await fileAppendPublisher(anchorsFile)
    const service = new AnchorService({ every: 3, publish })

    await service.onFlush([event(1), event(2), event(3)])
    await service.onFlush([event(4), event(5)])
    await service.onFlush([event(6)])

    const lines = readFileSync(anchorsFile, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    assert.lengthOf(lines, 2)
    assert.equal(JSON.parse(lines[0]!).seq, 3)
    assert.equal(JSON.parse(lines[1]!).seq, 6)
  })

  test('publishes anchor daily only once per day', async ({ assert }) => {
    const anchorsFile = join(dir, 'anchors.ndjson')
    const publish = await fileAppendPublisher(anchorsFile)
    const service = new AnchorService({ every: 'daily', publish })

    await service.onFlush([event(1)])
    await service.onFlush([event(2)])

    const lines = readFileSync(anchorsFile, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
    assert.lengthOf(lines, 1)
  })
})
