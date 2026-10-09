import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

/** GET /api/identity/groups/:groupId/join-requests — open join requests (`identity.join-requests:decide`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityJoining().listJoinRequests({ subject, groupId: identifierParam(event, 'groupId'), correlationId })
})
