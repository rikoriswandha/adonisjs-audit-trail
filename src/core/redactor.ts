export function createRedactor(_config: unknown): {
  redact: (values: Record<string, unknown>) => Record<string, unknown>
} {
  throw new Error('createRedactor: not implemented')
}
