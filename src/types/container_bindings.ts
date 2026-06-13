import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'
import type AuditOutboxDrainer from '../core/outbox_drainer.js'
import type AuditService from '../services/audit.js'
import type { ResolvedAuditConfig } from '../define_config.js'
import type { Redactor } from '../core/redactor.js'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    'audit.config': ResolvedAuditConfig
    'audit.manager': StoreManager
    'audit.pipeline': AuditPipeline
    'audit.redactor': Redactor
    'audit.outbox_drainer': AuditOutboxDrainer
    'audit': AuditService
  }
}
