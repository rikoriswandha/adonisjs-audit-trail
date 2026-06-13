import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class Audit extends BaseModel {
  static table = 'audits'

  @column({ isPrimary: true })
  declare id: string
  @column()
  declare seq: number

  @column()
  declare stream: string

  @column()
  declare event: string
}
