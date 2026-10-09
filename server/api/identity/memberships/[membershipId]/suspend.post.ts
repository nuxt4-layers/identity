import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityGovernance } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ reasonCode: z.string().max(64) })

/** POST /api/identity/memberships/:membershipId/suspend — suspends a member who is not an owner (`identity.memberships:suspend`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  const membershipId = identifierParam(event, 'membershipId')
  await getIdentityGovernance().actOnMember({ subject, membershipId, action: 'suspend', reasonCode: body.reasonCode, correlationId })
  return { membershipId, status: 'suspended' as const }
})
