import { test } from '@japa/runner'
import { createRedactor } from '../../src/core/redactor.js'
import { AuditRedactionSaltError } from '../../src/core/errors.js'
import { createHash } from 'node:crypto'

test.group('createRedactor', () => {
  test('exact key path redacts at any depth', ({ assert }) => {
    const { redact } = createRedactor({ paths: ['ssn'], mode: 'mask' })
    const result = redact({ ssn: '123-45-6789', nested: { ssn: '987-65-4321' }, name: 'Ada' })

    assert.equal(result.ssn, '[REDACTED]')
    assert.equal((result.nested as Record<string, unknown>).ssn, '[REDACTED]')
    assert.equal(result.name, 'Ada')
  })

  test('deep wildcard matches nested keys', ({ assert }) => {
    const { redact } = createRedactor({ paths: ['*.secret'], mode: 'mask' })
    const result = redact({ a: { secret: 'x' }, b: { c: { secret: 'y' } }, secret: 'z' })

    assert.equal((result.a as Record<string, unknown>).secret, '[REDACTED]')
    assert.equal(
      ((result.b as Record<string, unknown>).c as Record<string, unknown>).secret,
      '[REDACTED]'
    )
    assert.equal(result.secret, '[REDACTED]')
  })

  test('prefix wildcard matches keys under a parent', ({ assert }) => {
    const { redact } = createRedactor({ paths: ['card.*'], mode: 'mask' })
    const result = redact({
      card: { number: '4111', cvv: '123' },
      other: { number: '999' },
    })

    const card = result.card as Record<string, unknown>
    assert.equal(card.number, '[REDACTED]')
    assert.equal(card.cvv, '[REDACTED]')
    assert.equal((result.other as Record<string, unknown>).number, '999')
  })

  test('remove mode deletes keys', ({ assert }) => {
    const { redact } = createRedactor({ paths: ['password'], mode: 'remove' })
    const result = redact({ user: 'ada', password: 'secret' })

    assert.notProperty(result, 'password')
    assert.equal(result.user, 'ada')
  })

  test('hash mode replaces values with salted sha256', ({ assert }) => {
    const salt = 'pepper'
    const { redact } = createRedactor({ paths: ['token'], mode: 'hash', salt })
    const result = redact({ token: 'abc123', count: 42, active: true })

    const expected = `sha256:${createHash('sha256')
      .update(salt + 'abc123')
      .digest('hex')}`
    assert.equal(result.token, expected)
    assert.equal(result.count, 42)
    assert.equal(result.active, true)
  })

  test('hash mode without salt throws', ({ assert }) => {
    const error = assert.throws(() => createRedactor({ paths: ['token'], mode: 'hash' }))
    assert.instanceOf(error, AuditRedactionSaltError)
  })

  test('non-string values are handled in all modes', ({ assert }) => {
    const { redact: mask } = createRedactor({ paths: ['value'], mode: 'mask' })
    assert.equal(mask({ value: 42 }).value, '[REDACTED]')
    assert.equal(mask({ value: true }).value, '[REDACTED]')

    const { redact: remove } = createRedactor({ paths: ['value'], mode: 'remove' })
    assert.notProperty(remove({ value: 42 }), 'value')

    const { redact: hash } = createRedactor({ paths: ['value'], mode: 'hash', salt: 's' })
    assert.equal(
      hash({ value: 42 }).value,
      `sha256:${createHash('sha256').update('s42').digest('hex')}`
    )
  })
})
