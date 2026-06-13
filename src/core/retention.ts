import { AuditStoreError } from './errors.js'

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/i)
  if (!match) {
    throw new AuditStoreError(`Invalid retention duration: ${duration}`)
  }

  const value = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase()

  const msPerDay = 24 * 60 * 60 * 1000
  switch (unit) {
    case 'day':
    case 'days':
      return value * msPerDay
    case 'week':
    case 'weeks':
      return value * 7 * msPerDay
    case 'month':
    case 'months':
      return value * 30 * msPerDay
    case 'year':
    case 'years':
      return value * 365 * msPerDay
    default:
      throw new AuditStoreError(`Invalid retention duration: ${duration}`)
  }
}
