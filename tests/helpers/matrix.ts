import { test } from '@japa/runner'
import { DB_DIALECTS, isDialectEnabled, type DbDialect } from './dialect.js'

export const DB_MATRIX: readonly DbDialect[] = DB_DIALECTS

export function withDatabases(
  name: string,
  factory: (group: any, dialect: DbDialect) => void,
  options: { only?: DbDialect[] } = {}
): void {
  const dialects = options.only ?? DB_MATRIX

  for (const dialect of dialects) {
    if (!isDialectEnabled(dialect)) {
      continue
    }

    test.group(`${name} [${dialect}]`, (group) => {
      factory(group, dialect)
    })
  }
}
