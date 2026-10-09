import { z } from 'zod'
import { correlationOf, created, identityHandler, readJson, requireSubject } from '../../../internal/http'
import { getIdentityGovernance } from '../../../utils/identity-server'

const bodySchema = z.strictObject({ parentGroupId: z.string(), name: z.string().max(400) })

/** POST /api/identity/groups — creates a child group (`identity.groups:create` on the parent). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  const result = await getIdentityGovernance().createGroup({ subject, parentGroupId: body.parentGroupId, name: body.name, correlationId })
  created(event)
  return result
})
