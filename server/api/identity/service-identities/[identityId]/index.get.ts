import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityServiceIdentities } from '../../../../utils/identity-server'

/** GET /api/identity/service-identities/:identityId — one service identity, for whoever manages it. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityServiceIdentities().get({ subject, identityId: identifierParam(event, 'identityId'), correlationId })
})
