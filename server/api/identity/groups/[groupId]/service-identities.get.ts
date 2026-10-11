import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityServiceIdentities } from '../../../../utils/identity-server'

/** GET /api/identity/groups/:groupId/service-identities — the service identities the group owns (`identity.service-identities:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityServiceIdentities().list({ subject, groupId: identifierParam(event, 'groupId'), correlationId })
})
