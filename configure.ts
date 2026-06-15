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

export async function configure(command: Configure) {
  const flags = command.parsedFlags

  const outbox =
    flags.outbox ??
    (await command.prompt.confirm(
      'Enable transactional outbox mode? (requires audit_outbox table)',
      {
        default: false,
      }
    ))

  const multiTenant =
    flags.multiTenant ??
    flags['multi-tenant'] ??
    (await command.prompt.confirm('Is this a multi-tenant application?', {
      default: false,
    }))

  const immutability =
    flags.immutability ??
    (await command.prompt.confirm('Enforce DB-level immutability triggers on the audits table?', {
      default: true,
    }))

  const codemods = await command.createCodemods()

  await codemods.makeUsingStub(stubsRoot, 'config/audit.stub', {
    outbox,
    multiTenant,
    immutability,
  })

  await codemods.makeUsingStub(stubsRoot, 'migrations/create_audits_table.stub', {
    immutability,
    multiTenant,
  })

  if (outbox) {
    await codemods.makeUsingStub(stubsRoot, 'migrations/create_audit_outbox_table.stub', {})
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
