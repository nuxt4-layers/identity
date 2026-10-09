/**
 * Documented failure categories at Identity's boundary (improvement register
 * item 12).
 *
 * `forbidden` is deliberately coarse. It is the answer when the caller may
 * not act, and also when the identity, group, membership or invitation does
 * not exist, so no response says which. Detailed reasons stay on the server
 * and in events. `conflict` is returned only after the caller has been
 * authorised to see the resource (for example, removing the last owner).
 */
export const IDENTITY_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'insufficient-assurance',
  'validation-failed',
  'conflict',
  'rate-limited',
  'unavailable',
] as const

export type IdentityErrorCode = typeof IDENTITY_ERROR_CODES[number]

/** HTTP status used when an error code crosses the HTTP boundary. */
export const IDENTITY_ERROR_STATUS: Readonly<Record<IdentityErrorCode, number>> = Object.freeze({
  'unauthenticated': 401,
  'forbidden': 403,
  'insufficient-assurance': 403,
  'validation-failed': 400,
  'conflict': 409,
  'rate-limited': 429,
  'unavailable': 503,
})

/** JSON body returned by the layer's HTTP endpoints on failure. */
export interface IdentityErrorBody {
  code: IdentityErrorCode
  /** Localisation key for the user-facing message, e.g. `identity.error.forbidden`. */
  messageKey: string
}

export function isIdentityErrorCode(value: unknown): value is IdentityErrorCode {
  return typeof value === 'string' && (IDENTITY_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Raised when the host application has not supplied a required port. The
 * layer fails closed: it never falls back to an implicit store.
 */
export class IdentityCompositionError extends Error {
  readonly port: string

  constructor(port: string) {
    super(`Identity port '${port}' has not been supplied by the host application. See docs/composition-contract.md.`)
    this.name = 'IdentityCompositionError'
    this.port = port
  }
}
