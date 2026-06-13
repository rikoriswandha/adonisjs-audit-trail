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

export class AuditConfigurationError extends Error {
  code = 'E_AUDIT_CONFIGURATION_ERROR' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditConfigurationError'
  }
}

export class AuditPeerDependencyError extends Error {
  code = 'E_AUDIT_PEER_DEPENDENCY_MISSING' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditPeerDependencyError'
  }
}

export class AuditStoreConnectionError extends Error {
  code = 'E_AUDIT_STORE_CONNECTION_NOT_SUPPORTED' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditStoreConnectionError'
  }
}

export class AuditAnchorError extends Error {
  code = 'E_AUDIT_ANCHOR_HTTP_POST_FAILED' as const

  constructor(message: string) {
    super(message)
    this.name = 'AuditAnchorError'
  }
}

export class AuditPipelineRejectedError extends Error {
  code = 'E_AUDIT_PIPELINE_REJECTED' as const

  constructor(message = 'Audit event was not accepted by the pipeline') {
    super(message)
    this.name = 'AuditPipelineRejectedError'
  }
}

export class AuditOutboxPayloadError extends Error {
  code = 'E_AUDIT_OUTBOX_INVALID_PAYLOAD' as const

  constructor(message = 'Invalid audit outbox payload') {
    super(message)
    this.name = 'AuditOutboxPayloadError'
  }
}

export class AuditDroppedError extends Error {
  code = 'E_AUDIT_DROPPED' as const

  constructor(message = 'Audit event was dropped by the pipeline') {
    super(message)
    this.name = 'AuditDroppedError'
  }
}
