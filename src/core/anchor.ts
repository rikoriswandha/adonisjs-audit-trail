import { AuditAnchorError } from './errors.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChainHead } from '../types.js'

export interface AnchorConfig {
  every: number | 'daily'
  publish: (head: ChainHead) => Promise<void>
  anchorsFile?: string
}

interface AnchorState {
  lastSeq: number
  lastDate: string
}

export class AnchorService {
  readonly #config: AnchorConfig
  readonly #state: Map<string, AnchorState>

  constructor(config: AnchorConfig) {
    this.#config = config
    this.#state = new Map()
  }

  async onFlush(events: { stream: string; seq: number; hash: string }[]): Promise<void> {
    const heads = this.#lastPerStream(events)

    for (const [stream, head] of heads) {
      if (this.#shouldAnchor(stream, head)) {
        const chainHead: ChainHead = {
          stream,
          seq: head.seq,
          hash: head.hash,
          anchoredAt: new Date().toISOString(),
        }

        await this.#config.publish(chainHead)
        this.#state.set(stream, { lastSeq: head.seq, lastDate: chainHead.anchoredAt })
      }
    }
  }

  #lastPerStream(
    events: { stream: string; seq: number; hash: string }[]
  ): Map<string, { stream: string; seq: number; hash: string }> {
    const heads = new Map<string, { stream: string; seq: number; hash: string }>()
    for (const event of events) {
      const current = heads.get(event.stream)
      if (!current || event.seq > current.seq) {
        heads.set(event.stream, event)
      }
    }
    return heads
  }

  #shouldAnchor(stream: string, head: { seq: number }): boolean {
    if (this.#config.every === 'daily') {
      const state = this.#state.get(stream)
      const today = new Date().toISOString().slice(0, 10)
      return state === undefined || state.lastDate.slice(0, 10) !== today
    }

    const state = this.#state.get(stream)
    const lastBucket = state ? Math.floor(state.lastSeq / this.#config.every) : -1
    const currentBucket = Math.floor(head.seq / this.#config.every)
    return currentBucket > lastBucket
  }
}

export async function fileAppendPublisher(
  path: string
): Promise<(head: ChainHead) => Promise<void>> {
  return async (head) => {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true }).catch(() => {})
    await appendFile(path, `${JSON.stringify(head)}\n`)
  }
}

export async function httpPostPublisher(
  url: string,
  options?: { headers?: Record<string, string> }
): Promise<(head: ChainHead) => Promise<void>> {
  return async (head) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(head),
    })

    if (!response.ok) {
      throw new AuditAnchorError(
        `Anchor HTTP POST failed: ${response.status} ${await response.text()}`
      )
    }
  }
}
