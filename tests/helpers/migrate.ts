import type { ApplicationService } from '@adonisjs/core/types'

export async function runMigrations(app: ApplicationService): Promise<void> {
  const db = await app.container.make('lucid.db')
  const client = db.connection()

  if (!(await client.schema.hasTable('audits'))) {
    await client.schema.createTable('audits', (table) => {
      table.string('id').primary()
      table.string('stream').notNullable()
      table.bigInteger('seq').notNullable()
      table.string('hash', 64).notNullable()
      table.string('prev_hash', 64).notNullable()
      table.string('event').notNullable()
      table.string('auditable_type').nullable()
      table.string('auditable_id').nullable()
      table.json('old_values').nullable()
      table.json('new_values').nullable()
      table.json('metadata').nullable()
      table.string('actor_type').notNullable()
      table.string('actor_id').nullable()
      table.string('actor_label').nullable()
      table.string('tenant_id').nullable()
      table.string('request_id').nullable()
      table.string('correlation_id').nullable()
      table.string('ip_address').nullable()
      table.string('user_agent', 512).nullable()
      table.string('url', 2048).nullable()
      table.string('http_method').nullable()
      table.json('tags').notNullable()
      table.string('schema_version').notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()

      table.unique(['stream', 'seq'])
      table.index(['event'])
      table.index(['auditable_type', 'auditable_id'])
      table.index(['actor_type', 'actor_id'])
      table.index(['tenant_id'])
      table.index(['created_at'])
    })
  }

  if (!(await client.schema.hasTable('audit_archive_events'))) {
    await client.schema.createTable('audit_archive_events', (table) => {
      table.string('id').primary()
      table.string('stream').notNullable()
      table.bigInteger('seq').notNullable()
      table.string('hash', 64).notNullable()
      table.string('prev_hash', 64).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.unique(['stream', 'seq'])
    })
  }

  if (!(await client.schema.hasTable('audit_chain_checkpoints'))) {
    await client.schema.createTable('audit_chain_checkpoints', (table) => {
      table.string('stream').notNullable()
      table.bigInteger('seq').notNullable()
      table.string('hash', 64).notNullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.primary(['stream', 'seq'])
    })
  }

  if (!(await client.schema.hasTable('audit_maintenance_guard'))) {
    await client.schema.createTable('audit_maintenance_guard', (table) => {
      table.string('operation').primary()
    })
  }

  if (!(await client.schema.hasTable('audit_outbox'))) {
    await client.schema.createTable('audit_outbox', (table) => {
      table.uuid('id').primary()
      table.json('payload').notNullable()
      table.string('tenant_id').nullable()
      table.string('status').notNullable().defaultTo('pending')
      table.integer('attempts').unsigned().notNullable().defaultTo(0)
      table.timestamp('available_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('claimed_at', { useTz: true, precision: 3 }).nullable()
      table.timestamp('processed_at', { useTz: true, precision: 3 }).nullable()
      table.timestamp('failed_at', { useTz: true, precision: 3 }).nullable()
      table.text('last_error').nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).nullable()

      table.index(['status', 'available_at'])
      table.index(['status', 'tenant_id', 'available_at'])
    })
  }

  if (!(await client.schema.hasTable('posts'))) {
    await client.schema.createTable('posts', (table) => {
      table.increments('id')
      table.string('title').notNullable()
      table.text('body').nullable()
      table.timestamp('created_at', { useTz: true, precision: 3 }).notNullable()
      table.timestamp('updated_at', { useTz: true, precision: 3 }).nullable()
    })
  }
}
