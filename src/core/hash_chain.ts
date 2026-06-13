export const GENESIS = '0'.repeat(64)

export function hashEntry(_entry: unknown): string {
  throw new Error('hashEntry: not implemented')
}

export function chainBatch(_batch: unknown[], _head: unknown): unknown[] {
  throw new Error('chainBatch: not implemented')
}

export async function* verifyChain(_rows: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  throw new Error('verifyChain: not implemented')
}
