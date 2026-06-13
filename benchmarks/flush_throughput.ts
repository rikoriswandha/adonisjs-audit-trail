import { Bench } from 'tinybench'
import type { ApplicationService } from '@adonisjs/core/types'
import { createBenchmarkApp, cleanupTestApp } from './helpers/app.js'
import { runMigrations } from '../tests/helpers/migrate.js'
import type { ContainerHandle, DbDialect } from '../tests/helpers/containers.js'
import type { AuditEvent } from '../src/types.js'
import type StoreManager from '../src/stores/store_manager.js'
import type LucidStore from '../src/stores/lucid_store.js'

function makeEvent(seq: number): AuditEvent {
  return {
    id: `event-${seq}`,
    event: 'benchmark.flush',
    stream: 'default',
    auditableType: null,
    auditableId: null,
    oldValues: null,
    newValues: { seq },
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

export async function runFlushBenchmark(
  dialect: DbDialect = 'sqlite',
  batchSize = 200
): Promise<Bench> {
  const { app, container } = await createBenchmarkApp(dialect)
  await runMigrations(app)

  const manager = (await app.container.make('audit.manager')) as StoreManager
  const store = manager.use('lucid') as LucidStore
  let counter = 0

  const bench = new Bench({
    name: `flush throughput ${dialect} (batch ${batchSize})`,
    time: 5000,
  })

  bench.add(`write batch of ${batchSize}`, async () => {
    const batch = Array.from({ length: batchSize }, () => makeEvent(++counter))
    await store.write(batch)
  })

  await bench.run()
  await cleanupBenchmarkApp(app, container)
  return bench
}

async function cleanupBenchmarkApp(app: ApplicationService, container: ContainerHandle) {
  await cleanupTestApp(app)
  await container.stop()
}
