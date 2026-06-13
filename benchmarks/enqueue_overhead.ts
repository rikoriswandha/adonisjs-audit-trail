import { Bench } from 'tinybench'
import type { ApplicationService } from '@adonisjs/core/types'
import { createBenchmarkApp, cleanupTestApp } from './helpers/app.js'
import { runMigrations } from '../tests/helpers/migrate.js'
import { Post } from '../tests/helpers/models.js'
import type { ContainerHandle } from '../tests/helpers/containers.js'

export async function runEnqueueBenchmark(
  dialect: 'sqlite' | 'postgres' = 'sqlite'
): Promise<Bench> {
  const { app, container } = await createBenchmarkApp(dialect)
  await runMigrations(app)

  const bench = new Bench({
    name: `enqueue overhead (${dialect})`,
    time: 2000,
    setup: async () => {
      const pipeline = await app.container.make('audit.pipeline')
      pipeline.start()
    },
    teardown: async () => {
      const pipeline = await app.container.make('audit.pipeline')
      await pipeline.shutdown(5000)
    },
  })

  bench.add('audited model.save()', async () => {
    const post = new Post()
    post.title = 'Benchmark'
    post.body = null
    await post.save()
  })

  await bench.run()
  await cleanupBenchmarkApp(app, container)
  return bench
}

async function cleanupBenchmarkApp(app: ApplicationService, container: ContainerHandle) {
  await cleanupTestApp(app)
  await container.stop()
}
