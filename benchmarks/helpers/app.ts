import type { ApplicationService } from '@adonisjs/core/types'
import { createTestAppWithDb, cleanupTestApp } from '../../tests/helpers/app.js'
import type { ContainerHandle, DbDialect } from '../../tests/helpers/containers.js'
import { startBenchmarkContainer } from './db.js'

export async function createBenchmarkApp(
  dialect: DbDialect,
  auditConfig: Record<string, unknown> = {}
): Promise<{ app: ApplicationService; container: ContainerHandle }> {
  const container = await startBenchmarkContainer(dialect)
  if (!container) {
    throw new Error(`Failed to start ${dialect} container for benchmark`)
  }

  const app = await createTestAppWithDb(
    {
      default: 'lucid',
      queue: {
        flushIntervalMs: 60_000,
        maxBatchSize: 100_000,
        capacity: 100_000,
        overflow: 'dropOldest',
      },
      ...auditConfig,
      stores: {
        lucid: async (application: ApplicationService) => {
          const { default: LucidStore } = await import('../../src/stores/lucid_store.js')
          return new LucidStore(application, {})
        },
      },
    },
    container
  )

  return { app, container }
}

export { cleanupTestApp }
