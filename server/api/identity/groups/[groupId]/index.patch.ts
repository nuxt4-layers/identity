import { z } from 'zod'
import { correlationOf, identifierParam, identityHandler, readJson, requireSubject } from '../../../../internal/http'
import { getIdentityGovernance } from '../../../../utils/identity-server'

const bodySchema = z.strictObject({ name: z.string().max(400) })

/** PATCH /api/identity/groups/:groupId — renames a group (`identity.groups:rename`). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  const groupId = identifierParam(event, 'groupId')
  await getIdentityGovernance().renameGroup({ subject, groupId, name: body.name, correlationId })
  return { groupId, status: 'renamed' as const }
})
