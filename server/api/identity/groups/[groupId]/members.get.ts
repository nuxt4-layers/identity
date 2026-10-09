import { getQuery } from 'h3'
import { IdentityError } from '../../../../../contracts'
import { correlationOf, identifierParam, identityHandler, requireSubject } from '../../../../internal/http'
import { getIdentityQueries } from '../../../../utils/identity-server'

/** GET /api/identity/groups/:groupId/members?after= — a page of live memberships (`identity.memberships:view`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const after = getQuery(event).after
  if (after !== undefined && typeof after !== 'string') throw new IdentityError('validation-failed')
  return getIdentityQueries().members({ subject, groupId: identifierParam(event, 'groupId'), after: after ?? null, correlationId })
})
