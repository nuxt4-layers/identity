import { correlationOf, identityHandler, requireSubject } from '../../../internal/http'
import { getIdentityLifecycle } from '../../../utils/identity-server'

/** POST /api/identity/me/resume — resumes a paused identity. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const correlationId = correlationOf(event)
  return getIdentityLifecycle().resumeIdentity({ subject, correlationId })
})
