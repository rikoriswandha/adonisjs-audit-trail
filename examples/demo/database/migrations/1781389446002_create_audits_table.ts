import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'audits'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table.string('stream', 64).notNullable()
      table.bigInteger('seq').notNullable()
      table.string('hash', 64).notNullable()
      table.string('prev_hash', 64).notNullable()

      table.string('event', 128).notNullable()
      table.string('auditable_type', 128).nullable()
      table.string('auditable_id', 64).nullable()
      table.jsonb('old_values').nullable()
      table.jsonb('new_values').nullable()
      table.jsonb('metadata').nullable()

      table.string('actor_type', 64).nullable()
      table.string('actor_id', 64).nullable()
      table.string('actor_label', 255).nullable()

      table.string('tenant_id', 64).nullable()
      table.string('request_id', 64).nullable()
      table.string('correlation_id', 64).nullable()
      table.string('ip_address', 45).nullable()
      table.string('user_agent', 512).nullable()
      table.string('url', 2048).nullable()
      table.string('http_method', 10).nullable()
      table.jsonb('tags').notNullable()

      table.string('schema_version', 8).notNullable().defaultTo('1')
      table.timestamp('created_at', { useTz: true }).notNullable()

      table.unique(['stream', 'seq'])
      table.index(['auditable_type', 'auditable_id', 'seq'])
      table.index(['actor_type', 'actor_id', 'seq'])
      table.index(['event', 'created_at'])
      table.index(['stream', 'seq'])
      table.index(['tenant_id'])
    })

    const dialect = this.db.dialect.constructor.name
    if (dialect === 'PgDialect') {
      await this.db.rawQuery(
        'CREATE OR REPLACE FUNCTION prevent_audits_mutation() ' +
          'RETURNS trigger AS $$ ' +
          'BEGIN ' +
          "RAISE EXCEPTION 'audit rows are immutable'; " +
          'END; ' +
          '$$ LANGUAGE plpgsql;'
      )
      await this.db.rawQuery(
        'CREATE TRIGGER audits_immutable ' +
          'BEFORE UPDATE OR DELETE ON audits ' +
          'FOR EACH ROW EXECUTE FUNCTION prevent_audits_mutation();'
      )
    }

    if (dialect === 'MysqlDialect') {
      await this.db.rawQuery(
        'CREATE TRIGGER audits_before_update ' +
          'BEFORE UPDATE ON audits ' +
          "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows are immutable'"
      )
      await this.db.rawQuery(
        'CREATE TRIGGER audits_before_delete ' +
          'BEFORE DELETE ON audits ' +
          "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows are immutable'"
      )
    }
  }

  async down() {
    const dialect = this.db.dialect.constructor.name
    if (dialect === 'PgDialect') {
      await this.db.rawQuery('DROP TRIGGER IF EXISTS audits_immutable ON audits')
      await this.db.rawQuery('DROP FUNCTION IF EXISTS prevent_audits_mutation')
    }
    if (dialect === 'MysqlDialect') {
      await this.db.rawQuery('DROP TRIGGER IF EXISTS audits_before_update')
      await this.db.rawQuery('DROP TRIGGER IF EXISTS audits_before_delete')
    }

    this.schema.dropTable(this.tableName)
  }
}
