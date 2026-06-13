export class AuditCanonicalError extends Error {
  code = 'E_AUDIT_CANONICAL_INVALID_VALUE' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditCanonicalError'
  }
}

export class AuditCircularError extends Error {
  code = 'E_AUDIT_CANONICAL_CIRCULAR' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditCircularError'
  }
}

export class AuditRedactionSaltError extends Error {
  code = 'E_AUDIT_REDACTION_SALT_REQUIRED' as const

  constructor(message = 'Redaction mode "hash" requires a salt') {
    super(message)
    this.name = 'AuditRedactionSaltError'
  }
}
