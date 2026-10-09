import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityQueries } from '../../../../utils/identity-server'

/** GET /api/identity/groups/:groupId/changes — pending governance changes (`identity.groups:view`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityQueries().changes({ subject, groupId: identifierParam(event, 'groupId'), correlationId })
})
