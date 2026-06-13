import { test } from '@japa/runner'
import type { DbDialect } from './containers.js'

export const DB_MATRIX: DbDialect[] = ['sqlite', 'postgres', 'mysql']

export function withDatabases(
  name: string,
  factory: (group: any, dialect: DbDialect) => void,
  options: { only?: DbDialect[] } = {}
): void {
  const dialects = options.only ?? DB_MATRIX

  for (const dialect of dialects) {
    if (dialect !== 'sqlite' && process.env.SKIP_DOCKER_TESTS === '1') {
      continue
    }

    test.group(`${name} [${dialect}]`, (group) => {
      factory(group, dialect)
    })
  }
}
