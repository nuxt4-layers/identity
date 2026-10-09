import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ decision: z.enum(['approve', 'refuse']) })

/** POST /api/identity/join-requests/:joinRequestId/decision — approves or refuses (`identity.join-requests:decide`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityJoining().decideJoinRequest({ subject, joinRequestId: identifierParam(event, 'joinRequestId'), decision: body.decision, correlationId })
})
