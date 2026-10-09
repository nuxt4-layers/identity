import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityApprovals } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ decision: z.enum(['approve', 'reject']), changeDigest: z.string().max(64) })

/** POST /api/identity/changes/:changeId/decision — approves or rejects the change whose digest the approver was shown. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityApprovals().decide({ subject, changeId: identifierParam(event, 'changeId'), changeDigest: body.changeDigest, decision: body.decision, correlationId })
})
