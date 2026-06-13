import type { BaseModel } from '@adonisjs/lucid/orm'
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers'
import type { AuditableModelConfig } from '../types.js'

export function Auditable<T extends NormalizeConstructor<typeof BaseModel>>(superclass: T) {
  class AuditableModel extends superclass {
    static auditConfig?: AuditableModelConfig
  }
  return AuditableModel as typeof superclass & { auditConfig?: AuditableModelConfig }
}
