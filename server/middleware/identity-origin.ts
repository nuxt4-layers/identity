import { defineEventHandler } from 'h3'
import { useRuntimeConfig } from '#imports'
import { identityHttpError, originRejected } from '../internal/http'

/** CSRF defence for `/api/identity/*` (docs/contracts.md §19): state-changing requests must come from the configured origin. */
export default defineEventHandler((event) => {
  if (originRejected(event, useRuntimeConfig().identity?.baseUrl)) throw identityHttpError('forbidden')
})
