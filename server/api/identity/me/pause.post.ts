import { correlationOf, identityHandler, requireSubject } from '../../../internal/http'
import { getIdentityLifecycle } from '../../../utils/identity-server'

/** POST /api/identity/me/pause — pauses the whole identity (after reauthentication). */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityLifecycle().pauseIdentity({ subject, correlationId })
})
