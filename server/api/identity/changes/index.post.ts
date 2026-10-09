import { z } from 'zod'
import { correlationOf, created, identityHandler, readJson, requireSubject } from '../../../internal/http'
import { getIdentityApprovals } from '../../../utils/identity-server'

const bodySchema = z.strictObject({ request: z.unknown() })

/** POST /api/identity/changes — requests a governance change (§8). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  const change = await getIdentityApprovals().request({ subject, request: body.request, correlationId })
  created(event)
  return change
})
