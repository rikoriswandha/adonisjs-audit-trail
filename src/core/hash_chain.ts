import { createHash } from 'node:crypto'
import type { AuditEvent, ChainedAuditEvent, VerifyReport } from '../types.js'
import { canonicalJson } from './canonical_json.js'

export const GENESIS = '0'.repeat(64)

type HashableEntry = AuditEvent & { seq: number; prevHash: string }

export function pickHashedFields(entry: HashableEntry): Record<string, unknown> {
  return {
    id: entry.id,
    seq: entry.seq,
    stream: entry.stream,
    event: entry.event,
    auditableType: entry.auditableType,
    auditableId: entry.auditableId,
    oldValues: entry.oldValues,
    newValues: entry.newValues,
    metadata: entry.metadata,
    actor: {
      type: entry.actor.type,
      id: entry.actor.id,
    },
    tenantId: entry.tenantId,
    schemaVersion: entry.schemaVersion,
    createdAt: entry.createdAt,
    prevHash: entry.prevHash,
  }
}

export function hashEntry(entry: HashableEntry): string {
  const fields = pickHashedFields(entry)
  return createHash('sha256').update(canonicalJson(fields)).digest('hex')
}

export function chainBatch(
  batch: AuditEvent[],
  head: { seq: number; hash: string } | null
): ChainedAuditEvent[] {
  let seq = head ? head.seq + 1 : 1
  let prevHash = head ? head.hash : GENESIS
  const chained: ChainedAuditEvent[] = []

  for (const event of batch) {
    const row = { ...event, seq, prevHash }
    const hash = hashEntry(row)
    chained.push({ ...event, seq, prevHash, hash })
    seq++
    prevHash = hash
  }

  return chained
}

interface StreamState {
  prevSeq: number
  prevHash: string
  checked: number
  firstInvalidSeq?: number
}

export async function* verifyChain(
  rows: AsyncIterable<ChainedAuditEvent>
): AsyncGenerator<VerifyReport> {
  const streams = new Map<string, StreamState>()

  for await (const row of rows) {
    const state = streams.get(row.stream) ?? {
      prevSeq: 0,
      prevHash: GENESIS,
      checked: 0,
    }
    state.checked++
    streams.set(row.stream, state)

    const expectedSeq = state.prevSeq + 1
    const expectedHash = hashEntry({ ...row, seq: expectedSeq, prevHash: state.prevHash })
    const valid = row.seq === expectedSeq && row.hash === expectedHash

    if (valid) {
      state.prevSeq = row.seq
      state.prevHash = row.hash
      yield {
        stream: row.stream,
        valid: true,
        checkedCount: state.checked,
      }
      continue
    }

    if (state.firstInvalidSeq === undefined) {
      state.firstInvalidSeq = expectedSeq
    }

    yield {
      stream: row.stream,
      valid: false,
      firstInvalidSeq: state.firstInvalidSeq,
      expectedHash,
      actualHash: row.hash,
      checkedCount: state.checked,
    }
  }
}
