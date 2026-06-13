import { GenericContainer, type StartedTestContainer } from 'testcontainers'

export type DbDialect = 'sqlite' | 'postgres' | 'mysql'

export interface DbConnectionConfig {
  client: string
  connection: Record<string, unknown>
  useNullAsDefault?: boolean
}

export interface ContainerHandle {
  dialect: DbDialect
  config: DbConnectionConfig
  stop(): Promise<void>
}

function skipDocker(): boolean {
  return process.env.SKIP_DOCKER_TESTS === '1'
}

export async function startContainer(dialect: DbDialect): Promise<ContainerHandle | null> {
  if (dialect === 'sqlite') {
    return {
      dialect,
      config: {
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
      },
      stop: async () => {},
    }
  }

  if (skipDocker()) {
    return null
  }

  if (dialect === 'postgres') {
    return startPostgres()
  }

  return startMysql()
}

async function startPostgres(): Promise<ContainerHandle> {
  const container = await new GenericContainer('postgres:16')
    .withEnvironment({
      POSTGRES_USER: 'audit',
      POSTGRES_PASSWORD: 'audit',
      POSTGRES_DB: 'audit',
    })
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start()

  return buildHandle('postgres', container, {
    client: 'pg',
    connection: {
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'audit',
      password: 'audit',
      database: 'audit',
    },
  })
}

async function startMysql(): Promise<ContainerHandle> {
  const container = await new GenericContainer('mysql:8')
    .withEnvironment({
      MYSQL_ROOT_PASSWORD: 'audit',
      MYSQL_DATABASE: 'audit',
      MYSQL_USER: 'audit',
      MYSQL_PASSWORD: 'audit',
    })
    .withExposedPorts(3306)
    .withStartupTimeout(120_000)
    .start()

  return buildHandle('mysql', container, {
    client: 'mysql2',
    connection: {
      host: container.getHost(),
      port: container.getMappedPort(3306),
      user: 'audit',
      password: 'audit',
      database: 'audit',
    },
  })
}

function buildHandle(
  dialect: DbDialect,
  container: StartedTestContainer,
  config: DbConnectionConfig
): ContainerHandle {
  let stopped = false
  return {
    dialect,
    config,
    async stop() {
      if (stopped) return
      stopped = true
      await container.stop()
    },
  }
}
