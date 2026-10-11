import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityServiceIdentities } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ name: z.string().max(400) })

/** PATCH /api/identity/service-identities/:identityId — renames a service identity (`identity.service-identities:manage`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityServiceIdentities().rename({ subject, identityId: identifierParam(event, 'identityId'), name: body.name, correlationId })
})
