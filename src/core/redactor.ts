import { createHash } from 'node:crypto'
import type { RedactionMode } from '../types.js'
import { AuditRedactionSaltError } from './errors.js'

export interface RedactorConfig {
  paths: string[]
  mode: RedactionMode
  salt?: string
}

interface CompiledPattern {
  type: 'exact' | 'deep' | 'prefix'
  value: string
}

function compilePattern(pattern: string): CompiledPattern {
  if (pattern.startsWith('*.') && pattern.length > 2) {
    return { type: 'deep', value: pattern.slice(2) }
  }

  if (pattern.endsWith('.*') && pattern.length > 2) {
    return { type: 'prefix', value: pattern.slice(0, -2) }
  }

  return { type: 'exact', value: pattern }
}

function isRedacted(path: string[], patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.type === 'exact') {
      if (path[path.length - 1] === pattern.value) {
        return true
      }
      continue
    }

    if (pattern.type === 'deep') {
      if (path.includes(pattern.value)) {
        return true
      }
      continue
    }

    // prefix: pattern is "card.*" -> redact any key under a "card" parent
    if (path.length >= 2 && path[path.length - 2] === pattern.value) {
      return true
    }
  }

  return false
}

function hashValue(value: unknown, salt: string): string {
  const input = typeof value === 'string' ? value : String(value)
  return `sha256:${createHash('sha256')
    .update(salt + input)
    .digest('hex')}`
}

function redactValue(
  value: unknown,
  path: string[],
  patterns: CompiledPattern[],
  mode: RedactionMode,
  salt: string | undefined
): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        redactValue(item, [...path, String(index)], patterns, mode, salt)
      )
    }

    const result: Record<string, unknown> = {}
    for (const [key, childValue] of Object.entries(value)) {
      const childPath = [...path, key]

      if (isRedacted(childPath, patterns)) {
        if (mode === 'remove') {
          continue
        }

        if (mode === 'hash') {
          if (!salt) {
            throw new AuditRedactionSaltError()
          }
          result[key] = hashValue(childValue, salt)
          continue
        }

        result[key] = '[REDACTED]'
        continue
      }

      result[key] = redactValue(childValue, childPath, patterns, mode, salt)
    }

    return result
  }

  return value
}

export function createRedactor(config: RedactorConfig) {
  const patterns = config.paths.map(compilePattern)
  const salt = config.salt

  if (config.mode === 'hash' && !salt) {
    throw new AuditRedactionSaltError()
  }

  return {
    redact(values: Record<string, unknown>): Record<string, unknown> {
      return redactValue(values, [], patterns, config.mode, salt) as Record<string, unknown>
    },
  }
}
