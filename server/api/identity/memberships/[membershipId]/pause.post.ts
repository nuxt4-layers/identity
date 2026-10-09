import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityGovernance } from '../../../../utils/identity-server'

/** POST /api/identity/memberships/:membershipId/pause — the member pauses their own membership. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const membershipId = identifierParam(event, 'membershipId')
  await getIdentityGovernance().pauseMembership({ subject, membershipId, correlationId })
  return { membershipId, status: 'paused' as const }
})
