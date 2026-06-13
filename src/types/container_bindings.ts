import type StoreManager from '../stores/store_manager.js'
import type AuditPipeline from '../core/pipeline.js'
import type AuditService from '../services/audit.js'
import type { ResolvedAuditConfig } from '../define_config.js'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    'audit.config': ResolvedAuditConfig
    'audit.manager': StoreManager
    'audit.pipeline': AuditPipeline
    'audit': AuditService
  }
}
