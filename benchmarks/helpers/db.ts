import {
  startContainer,
  type ContainerHandle,
  type DbDialect,
} from '../../tests/helpers/containers.js'

export async function startBenchmarkContainer(dialect: DbDialect): Promise<ContainerHandle | null> {
  if (dialect === 'sqlite') {
    return {
      dialect: 'sqlite',
      config: {
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
      },
      stop: async () => {},
    }
  }
  return startContainer(dialect)
}
