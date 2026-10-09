import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityApprovals } from '../../../../utils/identity-server'

/** GET /api/identity/changes/:changeId — a pending change, for its requester, beneficiary, approvers and, in recovery, the group's members. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  return getIdentityApprovals().getPendingChange({ subject, changeId: identifierParam(event, 'changeId') })
})
