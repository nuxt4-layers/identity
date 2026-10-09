import { z } from 'zod'
import { correlationOf, identityHandler, readJson, requireSubject } from '../../../internal/http'
import { getIdentityLifecycle } from '../../../utils/identity-server'

const bodySchema = z.strictObject({ leaveGroupsOrphaned: z.boolean().optional() })

/** POST /api/identity/me/closure — requests closure (after reauthentication). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityLifecycle().requestClosure({ subject, leaveGroupsOrphaned: body.leaveGroupsOrphaned, correlationId })
})
