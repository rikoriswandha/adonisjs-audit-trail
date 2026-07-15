export const DB_DIALECTS = ['sqlite', 'postgres', 'mysql'] as const

export type DbDialect = (typeof DB_DIALECTS)[number]

/**
 * Database containers are deliberately opt-in: local unit runs never need a
 * Docker daemon, while CI enables the full matrix explicitly.
 */
export function isDialectEnabled(
  dialect: DbDialect,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  if (dialect === 'sqlite') {
    return true
  }

  return environment.RUN_DOCKER_TESTS === '1' && environment.SKIP_DOCKER_TESTS !== '1'
}

export function disabledDialectMessage(dialect: Exclude<DbDialect, 'sqlite'>): string {
  return `${dialect} integration tests are disabled; set RUN_DOCKER_TESTS=1 to require Docker-backed ${dialect} tests`
}
