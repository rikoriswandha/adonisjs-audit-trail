import { runEnqueueBenchmark } from './enqueue_overhead.js'
import { runFlushBenchmark } from './flush_throughput.js'

const dialect = process.env.BENCH_DB === 'postgres' ? 'postgres' : 'sqlite'

async function main() {
  console.log(`\nRunning audit-trail benchmarks against ${dialect}\n`)

  const enqueueBench = await runEnqueueBenchmark(dialect as 'sqlite' | 'postgres')
  console.log(enqueueBench.name)
  console.table(enqueueBench.table())

  const flushBench = await runFlushBenchmark(dialect as 'sqlite' | 'postgres')
  console.log(flushBench.name)
  console.table(flushBench.table())

  const flushTask = flushBench.tasks[0]
  if (flushTask?.result) {
    const throughput = (flushTask.result as any).throughput.mean as number
    const eventsPerSecond = throughput * 200
    console.log(`Flush throughput: ${Math.round(eventsPerSecond).toLocaleString()} events/s`)
  }

  const enqueueTask = enqueueBench.tasks[0]
  if (enqueueTask?.result) {
    const p99 = (enqueueTask.result as any).latency.p99 as number
    console.log(`Enqueue overhead (p99): ${(p99 * 1000).toFixed(3)} μs`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
