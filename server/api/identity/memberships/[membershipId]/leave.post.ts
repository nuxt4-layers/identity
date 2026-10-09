import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityGovernance } from '../../../../utils/identity-server'

/** POST /api/identity/memberships/:membershipId/leave — the member leaves. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const membershipId = identifierParam(event, 'membershipId')
  await getIdentityGovernance().leaveGroup({ subject, membershipId, correlationId })
  return { membershipId, status: 'ended' as const }
})
