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

export class AuditImmutableError extends Error {
  code = 'E_AUDIT_IMMUTABLE' as const

  constructor(message = 'Audit records are immutable and cannot be modified or deleted') {
    super(message)
    this.name = 'AuditImmutableError'
  }
}

export class AuditCoupledTimeoutError extends Error {
  code = 'E_AUDIT_COUPLED_TIMEOUT' as const

  constructor(message = 'Request-coupled audit flush timed out') {
    super(message)
    this.name = 'AuditCoupledTimeoutError'
  }
}

export class AuditStoreError extends Error {
  code = 'E_AUDIT_STORE_ERROR' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditStoreError'
  }
}
