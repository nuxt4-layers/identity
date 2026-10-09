import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

/** GET /api/identity/groups/:groupId/invitations — the group's invitations (`identity.invitations:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityJoining().listInvitations({ subject, groupId: identifierParam(event, 'groupId'), correlationId })
})
