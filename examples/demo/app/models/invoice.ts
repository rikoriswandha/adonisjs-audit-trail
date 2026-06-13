import { compose } from '@adonisjs/core/helpers'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { Auditable } from '@rikology/adonisjs-audit-trail/auditable'
import { DateTime } from 'luxon'

export default class Invoice extends compose(BaseModel, Auditable) {
  static auditConfig = {
    redact: ['iban'],
    tags: ['billing'],
  }

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare reference: string

  @column()
  declare iban: string

  @column()
  declare amount: number

  @column()
  declare status: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
