import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityApprovals } from '../../../../utils/identity-server'

/** POST /api/identity/changes/:changeId/cancel — the requester withdraws a change. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityApprovals().cancel({ subject, changeId: identifierParam(event, 'changeId'), correlationId })
})
