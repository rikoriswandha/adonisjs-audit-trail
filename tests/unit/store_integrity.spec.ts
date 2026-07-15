import { test } from '@japa/runner'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import FanoutStore from '../../src/stores/fanout_store.js'
import StreamStore from '../../src/stores/stream_store.js'
import type { AuditEvent, AuditStoreContract, ChainedAuditEvent } from '../../src/types.js'

function event(id: string): AuditEvent {
  return {
    id,
    event: 'test',
    stream: 'stream',
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
}

function store(write: (batch: AuditEvent[]) => Promise<ChainedAuditEvent[]>): AuditStoreContract {
  return {
    write,
    async head() {
      return null
    },
    async *verify() {},
    async prune() {
      return { streams: [], totalPruned: 0, perEvent: {} }
    },
  }
}

test('StreamStore serializes concurrent writes and advances the head after output', async ({
  assert,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-stream-integrity-'))
  const path = join(directory, 'audit.ndjson')
  const stream = new StreamStore({ destination: path })

  try {
    const [first, second] = await Promise.all([
      stream.write([event('a')]),
      stream.write([event('b')]),
    ])
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChainedAuditEvent)

    assert.equal(first[0].seq, 1)
    assert.equal(second[0].seq, 2)
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2]
    )
    const head = await stream.head('stream')
    assert.equal(head?.seq, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('StreamStore leaves the head unchanged when output fails', async ({ assert }) => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-stream-output-failure-'))
  const stream = new StreamStore({ destination: directory })

  try {
    await assert.rejects(() => stream.write([event('failed')]), /Stream store write failed/)
    assert.isNull(await stream.head('stream'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('FanoutStore does not commit primary when a throw-mode mirror fails', async ({ assert }) => {
  let primaryWrites = 0
  const primary = store(async (batch) => {
    primaryWrites++
    return batch.map((queued) => ({
      ...queued,
      seq: 1,
      hash: 'a'.repeat(64),
      prevHash: '0'.repeat(64),
    }))
  })
  const mirror = store(async () => {
    throw new Error('mirror unavailable')
  })
  const fanout = new FanoutStore({ primary, mirrors: [mirror], mirrorFailure: 'throw' })

  await assert.rejects(() => fanout.write([event('a')]), /Fanout mirror failed/)
  assert.equal(primaryWrites, 0)
})
