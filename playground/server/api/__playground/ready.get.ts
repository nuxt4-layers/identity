import { createError, defineEventHandler } from 'h3'
import { playground } from '../../plugins/composition'

/** Test mode only: resolves once the database is migrated. */
export default defineEventHandler(async () => {
  if (process.env.IDENTITY_PLAYGROUND_TEST !== '1') throw createError({ statusCode: 404 })
  await playground.ready
  return { ready: true }
})
