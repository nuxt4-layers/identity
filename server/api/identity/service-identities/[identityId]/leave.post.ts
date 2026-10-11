import { z } from 'zod'
import { identifierSchema } from '../../../../../contracts'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityServiceIdentities } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ groupId: identifierSchema })

/** POST /api/identity/service-identities/:identityId/leave — takes the service identity out of a group (`identity.service-identities:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityServiceIdentities().leave({ subject, identityId: identifierParam(event, 'identityId'), groupId: body.groupId, correlationId })
})
