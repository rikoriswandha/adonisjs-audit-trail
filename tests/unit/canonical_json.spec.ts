import { test } from '@japa/runner'
import { canonicalJson } from '../../src/core/canonical_json.js'
import { AuditCanonicalError, AuditCircularError } from '../../src/core/errors.js'

function randomObject(depth = 0): unknown {
  const types = ['string', 'number', 'boolean', 'null', 'object', 'array']
  const type = types[Math.floor(Math.random() * types.length)]

  switch (type) {
    case 'string':
      return Math.random().toString(36)
    case 'number':
      return Math.random() * 1000
    case 'boolean':
      return Math.random() > 0.5
    case 'null':
      return null
    case 'array':
      return depth < 4 ? Array.from({ length: 3 }, () => randomObject(depth + 1)) : []
    case 'object':
    default:
      return depth < 4
        ? Object.fromEntries(
            Array.from({ length: 4 }, (_, i) => [
              String.fromCharCode(97 + i),
              randomObject(depth + 1),
            ])
          )
        : {}
  }
}

test.group('canonicalJson', () => {
  test('is idempotent over random nested objects', ({ assert }) => {
    for (let i = 0; i < 1000; i++) {
      const value = randomObject()
      const first = canonicalJson(value)
      const second = canonicalJson(structuredClone(value))
      assert.equal(first, second)
    }
  })

  test('sorts object keys lexicographically', ({ assert }) => {
    const a = canonicalJson({ b: 2, a: 1 })
    const b = canonicalJson({ a: 1, b: 2 })
    assert.equal(a, b)
    assert.equal(a, '{"a":1,"b":2}')
  })

  test('drops undefined values from objects', ({ assert }) => {
    assert.equal(canonicalJson({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}')
  })

  test('throws when top-level value is undefined', ({ assert }) => {
    assert.throws(() => canonicalJson(undefined), /Cannot canonicalize undefined value/)
  })

  test('preserves null', ({ assert }) => {
    assert.equal(canonicalJson({ a: null }), '{"a":null}')
  })

  test('rejects functions, symbols, and bigint', ({ assert }) => {
    assert.throws(() => canonicalJson({ fn: () => {} }), /function/)
    assert.throws(() => canonicalJson({ sym: Symbol('x') }), /symbol/)
    assert.throws(() => canonicalJson({ big: BigInt(1) }), /bigint/)
  })

  test('throws on circular references', ({ assert }) => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    try {
      canonicalJson(obj)
      assert.fail('Expected circular reference to throw')
    } catch (error) {
      assert.instanceOf(error, AuditCircularError)
      assert.equal((error as AuditCircularError).code, 'E_AUDIT_CANONICAL_CIRCULAR')
    }
  })

  test('serializes empty objects and nested arrays', ({ assert }) => {
    assert.equal(canonicalJson({}), '{}')
    assert.equal(canonicalJson({ arr: [3, 2, 1] }), '{"arr":[3,2,1]}')
  })
  test('rejects Date objects', ({ assert }) => {
    try {
      canonicalJson({ at: new Date() })
      assert.fail('Expected Date object to throw')
    } catch (error) {
      assert.instanceOf(error, AuditCanonicalError)
      assert.equal((error as AuditCanonicalError).code, 'E_AUDIT_CANONICAL_INVALID_VALUE')
    }
  })
})
