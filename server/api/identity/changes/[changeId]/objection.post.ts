import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityApprovals } from '../../../../utils/identity-server'

/** POST /api/identity/changes/:changeId/objection — a member objects to an orphaned group's recovery. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityApprovals().object({ subject, changeId: identifierParam(event, 'changeId'), correlationId })
})
