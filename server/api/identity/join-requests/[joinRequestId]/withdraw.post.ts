import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

/** POST /api/identity/join-requests/:joinRequestId/withdraw — the person withdraws their own request. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityJoining().withdrawJoinRequest({ subject, joinRequestId: identifierParam(event, 'joinRequestId'), correlationId })
})
