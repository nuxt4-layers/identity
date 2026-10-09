import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityGovernance } from '../../../../utils/identity-server'

/** POST /api/identity/memberships/:membershipId/resume — the member resumes their own membership. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const membershipId = identifierParam(event, 'membershipId')
  await getIdentityGovernance().resumeMembership({ subject, membershipId, correlationId })
  return { membershipId, status: 'active' as const }
})
