import { z } from 'zod'
import { identifierSchema, instantSchema, sha256DigestSchema, versionSchema } from './identifiers'
import { MEMBERSHIP_KINDS } from './membership'

/**
 * Invitations (improvement register item 20; iam-integration joining and
 * leaving).
 *
 * An invitation is a bearer token. Identity never receives the address it is
 * sent to: the host's invitation endpoint asks Identity for an invitation,
 * receives the token once, and hands token and address to its own delivery
 * (a notification capability). Identity stores only the token's SHA-256
 * digest, so a copy of its schema cannot be used to accept anything.
 *
 * - Single use, and expires after the policy's `invitationExpiryDays` (14).
 * - Accepted only by the signed-in identity that holds the token, which is
 *   provisioned first if new; nobody joins without their consent, except a
 *   service identity added by an administrator.
 * - An invitation to an existing identity is bound to it: only that identity
 *   may accept.
 * - Responses never reveal whether a group, identity or invitation exists, or
 *   whether an address has an account (the address never reaches Identity).
 * - Creation and acceptance are rate-limited (policy `invitationRateLimits`).
 */

/** Bytes of randomness in a token: 256 bits. */
export const INVITATION_TOKEN_BYTES = 32

/** A token as delivered: 43 characters of unpadded base64url. Never stored, never logged. */
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Expected an invitation token')

export const INVITATION_STATES = ['open', 'accepted', 'declined', 'revoked', 'expired'] as const
export type InvitationState = typeof INVITATION_STATES[number]

export const invitationSchema = z.strictObject({
  invitationId: identifierSchema,
  groupId: identifierSchema,
  tenantId: identifierSchema,
  kind: z.enum(MEMBERSHIP_KINDS),
  /** Set when the invitation is for an existing identity; only it may accept. */
  inviteeIdentityId: identifierSchema.nullable(),
  /** SHA-256 of the token's bytes. The token itself is never stored. */
  tokenDigest: sha256DigestSchema,
  invitedBy: identifierSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema,
  /** Dates for the membership it creates (scheduled joiners and leavers). */
  membershipStartsAt: instantSchema.nullable(),
  membershipEndsAt: instantSchema.nullable(),
  state: z.enum(INVITATION_STATES),
  acceptedBy: identifierSchema.nullable(),
  decidedAt: instantSchema.nullable(),
  version: versionSchema,
})

export type InvitationRecord = z.infer<typeof invitationSchema>

/**
 * The one answer to "create an invitation" and "accept an invitation"
 * whenever the request is well-formed, whatever happened, so neither can be
 * used to probe for groups, identities or tokens.
 */
export const INVITATION_ACKNOWLEDGEMENT = Object.freeze({ status: 'accepted' } as const)
