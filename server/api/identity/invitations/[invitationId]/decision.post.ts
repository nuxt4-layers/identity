import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ decision: z.enum(['confirm', 'refuse']) })

/** POST /api/identity/invitations/:invitationId/decision — confirms or refuses who accepted (`identity.invitations:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityJoining().decideAcceptance({ subject, invitationId: identifierParam(event, 'invitationId'), decision: body.decision, correlationId })
})
