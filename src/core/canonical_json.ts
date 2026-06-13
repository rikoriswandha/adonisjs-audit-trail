import { AuditCanonicalError, AuditCircularError } from './errors.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && value.constructor === Object
}

function serialize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null
  }

  const type = typeof value

  if (type === 'undefined') {
    throw new AuditCanonicalError('Cannot canonicalize undefined value')
  }

  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new AuditCanonicalError(`Cannot canonicalize value of type ${type}`)
  }

  if (type !== 'object') {
    return value
  }

  if (value instanceof Date) {
    throw new AuditCanonicalError(
      'Date objects must be serialized to ISO strings before canonicalization'
    )
  }

  if (seen.has(value as object)) {
    throw new AuditCircularError('Circular reference detected during canonicalization')
  }

  seen.add(value as object)

  try {
    if (Array.isArray(value)) {
      return value.map((item) => serialize(item, seen))
    }

    if (!isPlainObject(value)) {
      throw new AuditCanonicalError(
        `Cannot canonicalize value of type ${(value as object).constructor?.name ?? 'object'}`
      )
    }

    const sorted: Record<string, unknown> = {}
    const keys = Object.keys(value).sort()

    for (const key of keys) {
      const propertyValue = (value as Record<string, unknown>)[key]
      if (typeof propertyValue === 'undefined') {
        continue
      }
      sorted[key] = serialize(propertyValue, seen)
    }

    return sorted
  } finally {
    seen.delete(value as object)
  }
}

/**
 * Deterministic JSON serializer.
 *
 * - Object keys are sorted lexicographically (recursive).
 * - Arrays preserve order.
 * - `undefined` values are dropped from objects (top-level `undefined` throws).
 * - `null` is preserved.
 * - Functions, symbols, bigint, Date objects, and non-plain objects throw.
 * - Circular references throw.
 * - No whitespace is emitted.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'undefined') {
    throw new AuditCanonicalError('Cannot canonicalize undefined value')
  }

  return JSON.stringify(serialize(value, new WeakSet<object>()))
}
