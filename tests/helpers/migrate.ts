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
      table.timestamp('created_at').notNullable()

      table.unique(['stream', 'seq'])
      table.index(['event'])
      table.index(['auditable_type', 'auditable_id'])
      table.index(['actor_type', 'actor_id'])
      table.index(['tenant_id'])
      table.index(['created_at'])
    })
  }

  if (!(await client.schema.hasTable('audit_outbox'))) {
    await client.schema.createTable('audit_outbox', (table) => {
      table.increments('id')
      table.json('payload').notNullable()
      table.integer('attempts').unsigned().notNullable().defaultTo(0)
      table.timestamp('claimed_at').nullable()
      table.timestamp('processed_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['processed_at', 'claimed_at'])
    })
  }

  if (!(await client.schema.hasTable('posts'))) {
    await client.schema.createTable('posts', (table) => {
      table.increments('id')
      table.string('title').notNullable()
      table.text('body').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
    })
  }
}
