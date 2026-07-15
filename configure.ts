/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
|
| The configure hook is called when someone runs "node ace configure <package>"
| command. You are free to perform any operations inside this function to
| configure the package.
|
| To make things easier, you have access to the underlying "Configure"
| instance and you can use codemods to modify the source files.
|
*/

import { fileURLToPath } from 'node:url'
import type Configure from '@adonisjs/core/commands/configure'

const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
type ConfigureFlags = Record<string, unknown>

function flagValue(flags: ConfigureFlags, dashedName: string, camelName: string): unknown {
  return flags[dashedName] ?? flags[camelName]
}

function stringOption(
  flags: ConfigureFlags,
  dashedName: string,
  camelName: string,
  fallback: string
): string {
  const value = flagValue(flags, dashedName, camelName)

  if (value === undefined) {
    return fallback
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${dashedName} must be a non-empty string`)
  }

  return value
}

function tableOption(
  flags: ConfigureFlags,
  dashedName: string,
  camelName: string,
  fallback: string
): string {
  const value = stringOption(flags, dashedName, camelName, fallback)

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`--${dashedName} must be a SQL identifier`)
  }

  return value
}

function connectionOption(
  flags: ConfigureFlags,
  dashedName: string,
  camelName: string
): string | undefined {
  const value = flagValue(flags, dashedName, camelName)

  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`--${dashedName} must be a connection name`)
  }

  return value
}

function booleanOption(
  flags: ConfigureFlags,
  dashedName: string,
  camelName: string,
  prompt: () => Promise<boolean>
): Promise<boolean> {
  const value = flagValue(flags, dashedName, camelName)

  if (value === undefined) {
    return prompt()
  }

  if (value === 'true' || value === 'false') {
    return Promise.resolve(value === 'true')
  }

  if (typeof value !== 'boolean') {
    throw new Error(`--${dashedName} must be a boolean`)
  }

  return Promise.resolve(value)
}

export async function configure(command: Configure) {
  const flags = command.parsedFlags as ConfigureFlags

  const outbox = await booleanOption(flags, 'outbox', 'outbox', () =>
    command.prompt.confirm('Enable transactional outbox mode? (requires audit_outbox table)', {
      default: false,
    })
  )
  const multiTenant = await booleanOption(flags, 'multi-tenant', 'multiTenant', () =>
    command.prompt.confirm('Is this a multi-tenant application?', {
      default: false,
    })
  )
  const immutability = await booleanOption(flags, 'immutability', 'immutability', () =>
    command.prompt.confirm('Enforce DB-level immutability triggers on the audits table?', {
      default: true,
    })
  )
  const auditTable = tableOption(flags, 'audit-table', 'auditTable', 'audits')
  const auditConnection = connectionOption(flags, 'audit-connection', 'auditConnection')
  const outboxTable = tableOption(flags, 'outbox-table', 'outboxTable', 'audit_outbox')
  const outboxConnection = connectionOption(flags, 'outbox-connection', 'outboxConnection')

  const codemods = await command.createCodemods()

  await codemods.makeUsingStub(stubsRoot, 'config/audit.stub', {
    auditConnection,
    auditTable,
    multiTenant,
    outbox,
    outboxConnection,
    outboxTable,
  })

  await codemods.makeUsingStub(stubsRoot, 'migrations/create_audits_table.stub', {
    auditConnection,
    auditTable,
    immutability,
  })

  if (outbox) {
    await codemods.makeUsingStub(stubsRoot, 'migrations/create_audit_outbox_table.stub', {
      outboxConnection,
      outboxTable,
    })
  }

  await codemods.makeUsingStub(stubsRoot, 'transformers/audit_transformer.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'start/audit_events.stub', {})

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@rikology/adonisjs-audit-trail/audit_provider')
    rcFile.addCommand('@rikology/adonisjs-audit-trail/commands')
  })

  await codemods.registerMiddleware('router', [
    { path: '@rikology/adonisjs-audit-trail/audit_context_middleware' },
  ])

  await codemods.defineEnvValidations({
    variables: { AUDIT_REDACTION_SALT: 'Env.schema.string.optional()' },
    leadingComment: 'Variables for @rikology/adonisjs-audit-trail',
  })

  command.logger.success(
    '@rikology/adonisjs-audit-trail configured. Next: run `node ace migration:run` and review config/audit.ts'
  )
}
