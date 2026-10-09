import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

/** POST /api/identity/invitations/:invitationId/revoke — revokes an invitation (`identity.invitations:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityJoining().revoke({ subject, invitationId: identifierParam(event, 'invitationId'), correlationId })
})
