import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityJoining } from '../../../../utils/identity-server'

/** POST /api/identity/groups/:groupId/join — joins an open group, or asks to join. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityJoining().requestToJoin({ subject, groupId: identifierParam(event, 'groupId'), correlationId })
})
