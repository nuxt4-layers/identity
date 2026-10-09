import { correlationOf, identityHandler, requireSubject } from '../../../internal/http'
import { getIdentityLifecycle } from '../../../utils/identity-server'

/** DELETE /api/identity/me/closure — cancels a requested closure (after reauthentication). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityLifecycle().cancelClosure({ subject, correlationId })
})
