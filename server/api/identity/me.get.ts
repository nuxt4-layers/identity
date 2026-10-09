import { IdentityError } from '../../../contracts'
import { correlationOf, identityHandler, requireSubject } from '../../internal/http'
import { getIdentityQueries } from '../../utils/identity-server'

/** GET /api/identity/me — the signed-in identity's own view. */
export default identityHandler(async (event) => {
  const subject = await requireSubject(event)
  const view = await getIdentityQueries().self({ subject })
  if (!view) throw new IdentityError('forbidden')
  return view
})
