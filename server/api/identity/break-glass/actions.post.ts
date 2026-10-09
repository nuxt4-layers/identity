import { z } from 'zod'
import { BREAK_GLASS_ACTIONS } from '../../../../contracts'
import { correlationOf, created, identityHandler, readJson, requireSubject } from '../../../internal/http'
import { getIdentityBreakGlass } from '../../../utils/identity-server'

const bodySchema = z.strictObject({ action: z.enum(BREAK_GLASS_ACTIONS), targetId: z.string(), reasonCode: z.string().max(64) })

/** POST /api/identity/break-glass/actions — a break-glass action (ADR-0007). Closing its review is server-only: the host attests who held the passkey. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  const body = await readJson(event, bodySchema)
  const review = await getIdentityBreakGlass().act({ subject, action: body.action, targetId: body.targetId, reasonCode: body.reasonCode, correlationId })
  created(event)
  return review
})
