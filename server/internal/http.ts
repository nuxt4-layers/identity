import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { createError, defineEventHandler, getRequestHeader, getRequestURL, getRouterParam, isError, readBody, setResponseStatus } from 'h3'
import type { z } from 'zod'
import type { IdentityErrorBody, IdentityErrorCode, IdentitySubject } from '../../contracts'
import {
  IDENTITY_API_PREFIX,
  IDENTITY_CORRELATION_HEADER,
  IDENTITY_ERROR_STATUS,
  IdentityCompositionError,
  IdentityError,
  identitySubjectSchema,
  UUID_PATTERN,
  UUID_V7_PATTERN,
} from '../../contracts'
import { useIdentitySubjectResolver } from '../utils/identity-composition'

/**
 * PRIVATE. The HTTP boundary of the layer's `/api/identity/*` endpoints
 * (docs/contracts.md §19).
 *
 * - Errors cross as `IdentityErrorBody`: the contract code, a localisation
 *   key, and, for `conflict` and `validation-failed` only, the rule as a
 *   code. `forbidden` never says why. Unexpected failures are logged
 *   without detail and answered `unavailable`.
 * - Bodies are JSON objects parsed with strict schemas.
 * - The subject comes only from the host's subject resolver (Authentication),
 *   never from the request body.
 */

const REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function identityHttpError(code: IdentityErrorCode, reason?: string) {
  const data: IdentityErrorBody = { code, messageKey: `identity.error.${code}` }
  if (reason && (code === 'conflict' || code === 'validation-failed')) {
    const bare = reason.startsWith('identity:') ? reason.slice('identity:'.length) : reason
    if (bare !== code && REASON.test(bare) && bare.length <= 64) data.reason = bare
  }
  return createError({ statusCode: IDENTITY_ERROR_STATUS[code], statusMessage: code, data })
}

/** Translates anything thrown inside a handler into a contract error. */
export function toHttpError(error: unknown) {
  if (isError(error)) return error
  if (error instanceof IdentityError) {
    if (error.code === 'unavailable') console.error('[identity] request failed:', error.message)
    return identityHttpError(error.code, error.message)
  }
  if (error instanceof IdentityCompositionError) {
    console.error(`[identity] ${error.message}`)
    return identityHttpError('unavailable')
  }
  console.error('[identity] unexpected failure:', error instanceof Error ? error.message : error)
  return identityHttpError('unavailable')
}

/** Wraps a handler so that every failure leaves as a contract error. */
export function identityHandler<T>(run: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    try {
      return await run(event)
    }
    catch (error) {
      throw toHttpError(error)
    }
  })
}

/** The request's correlation identifier: the client's, when it sent a valid one, otherwise a new one. */
export function correlationOf(event: H3Event): string {
  const sent = getRequestHeader(event, IDENTITY_CORRELATION_HEADER)?.toLowerCase()
  return sent && UUID_PATTERN.test(sent) ? sent : randomUUID()
}

/** The signed-in subject, from the host's resolver. `unauthenticated` without one; `unavailable` if the resolver fails. */
export async function requireSubject(event: H3Event): Promise<IdentitySubject> {
  const resolver = useIdentitySubjectResolver()
  let subject: unknown
  try {
    subject = await resolver.resolve(event)
  }
  catch {
    throw new IdentityError('unavailable', 'subject resolver failed')
  }
  if (subject == null) throw new IdentityError('unauthenticated')
  const parsed = identitySubjectSchema.safeParse(subject)
  if (!parsed.success) throw new IdentityError('unavailable', 'subject resolver returned a malformed subject')
  return parsed.data
}

/** A route parameter that must be an identifier. */
export function identifierParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name)
  if (!value || !UUID_V7_PATTERN.test(value)) throw new IdentityError('validation-failed')
  return value
}

/** The JSON body, parsed with a strict schema. A missing body is an empty object. */
export async function readJson<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await readBody(event)
  }
  catch {
    throw new IdentityError('validation-failed')
  }
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) throw new IdentityError('validation-failed')
  return parsed.data
}

export function created(event: H3Event): void {
  setResponseStatus(event, 201)
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF defence for the layer's state-changing endpoints, as Authentication's:
 * the request must carry an Origin (or, failing that, a Referer) matching the
 * configured base URL. Without a configured base URL, every state-changing
 * request is refused.
 */
export function originRejected(event: H3Event, baseUrl: string | undefined): boolean {
  if (!getRequestURL(event).pathname.startsWith(`${IDENTITY_API_PREFIX}/`)) return false
  if (SAFE_METHODS.has(event.method)) return false
  let expected: string
  try {
    expected = new URL(baseUrl ?? '').origin
  }
  catch {
    return true
  }
  const origin = getRequestHeader(event, 'origin')
  const referer = getRequestHeader(event, 'referer')
  try {
    const actual = origin ? new URL(origin).origin : referer ? new URL(referer).origin : null
    return actual !== expected
  }
  catch {
    return true
  }
}
