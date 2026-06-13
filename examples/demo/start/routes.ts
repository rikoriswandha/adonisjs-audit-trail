/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import audit from '@rikology/adonisjs-audit-trail/services/main'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.post('login', [controllers.AccessTokens, 'store'])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
  })
  .prefix('/api/v1')

router.post('/demo/invoices/:id/approve', async ({ params }) => {
  const { default: Invoice } = await import('#models/invoice')
  const invoiceId = Number(params.id)

  // Automatic audit: create + update are captured by the mixin.
  const invoice = await Invoice.firstOrCreate(
    { id: invoiceId },
    {
      id: invoiceId,
      reference: `INV-${params.id}`,
      iban: 'DE89370400440532013000',
      amount: 1000,
      status: 'draft',
    }
  )

  invoice.status = 'approved'
  await invoice.save()

  // Explicit domain event.
  await audit.log('invoice.approved').on(invoice).withMeta({ approvedVia: 'demo' }).commit()

  return { ok: true, invoiceId: invoice.id }
})
