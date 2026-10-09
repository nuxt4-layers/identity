import { z } from 'zod'
import { correlationOf, identityHandler, readJson, requireSubject } from '../../../internal/http'
import { getIdentityJoining } from '../../../utils/identity-server'

const bodySchema = z.strictObject({ token: z.string().max(64) })

/** POST /api/identity/invitations/accept — the token's holder accepts. Always the same answer, unless rate-limited. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  return getIdentityJoining().accept({ subject, token: body.token, correlationId })
})
