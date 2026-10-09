import { z } from 'zod'
import { correlationIdSchema, identifierSchema, instantSchema } from './identifiers'
import { IDENTITY_KINDS, IDENTITY_STATES } from './identity'
import { invitationTokenSchema } from './invitation'

/**
 * The provisioning port Identity provides to Authentication (docs/contracts.md
 * §9.1; iam-integration provisioning).
 *
 * Provisioning is two-step, because Authentication's engine creates its user
 * record (and needs the identity identifier) at sign-up, before the sign-in
 * identifier is verified:
 *
 * 1. `reserve` issues a UUIDv7 in state `pending`. No personal data is sent.
 *    Idempotent by `requestId`: a retried call returns the same identity.
 * 2. `confirm`, once Authentication has verified the sign-in identifier,
 *    creates the personal group and its permanent membership and makes the
 *    identity `active` in one transaction, writing `identity.provisioned`.
 *    Idempotent: confirming an active identity returns it unchanged.
 *
 * An identity not confirmed within the policy's `pendingConfirmationHours`
 * (24) is closed and `identity.provisioning-expired` is written, so that
 * Authentication can discard its unverified account.
 */

export const provisioningReserveInputSchema = z.strictObject({
  /** Authentication's idempotency key for this sign-up attempt. */
  requestId: identifierSchema,
  kind: z.literal('person'),
  /**
   * The home tenant: the inviting tenant for an invitation, resolved on the
   * server; otherwise omitted for the policy's default. Never taken from the client.
   */
  homeTenantId: identifierSchema.optional(),
  /**
   * For a sign-up through an invitation: the token, from which Identity
   * resolves the inviting tenant on the server. Never stored or logged; the
   * invitation is not accepted by this call. Not with `homeTenantId`.
   */
  invitationToken: invitationTokenSchema.optional(),
  correlationId: correlationIdSchema,
}).refine(input => !(input.homeTenantId && input.invitationToken), { message: 'Supply a home tenant or an invitation token, not both' })

export const provisioningReservationSchema = z.strictObject({
  identityId: identifierSchema,
  state: z.literal('pending'),
  expiresAt: instantSchema,
})

export const provisioningConfirmInputSchema = z.strictObject({
  identityId: identifierSchema,
  correlationId: correlationIdSchema,
})

export const provisionedIdentitySchema = z.strictObject({
  identityId: identifierSchema,
  state: z.literal('active'),
  personalGroupId: identifierSchema,
  homeTenantId: identifierSchema,
})

/**
 * Whether an identity may hold a session (iam-integration architecture §4
 * rule 3). Authentication refuses sign-in and session refresh accordingly:
 *
 * - `allowed` — `active`;
 * - `resume-only` — `paused`: may view and resume;
 * - `cancel-closure-only` — `closure-pending`: may only cancel closure;
 * - `verification-only` — `pending`: may only complete verification;
 * - `refused` — `suspended`, `closed`, or unknown.
 */
export const SIGN_IN_OUTCOMES = ['allowed', 'resume-only', 'cancel-closure-only', 'verification-only', 'refused'] as const

export const signInStatusSchema = z.strictObject({
  identityId: identifierSchema,
  kind: z.enum(IDENTITY_KINDS),
  state: z.enum(IDENTITY_STATES),
  signIn: z.enum(SIGN_IN_OUTCOMES),
  /** True for break-glass identities (ADR-0007 §3): passkey only, never a password or recovery code. */
  passkeyOnly: z.boolean(),
})

export type SignInStatus = z.infer<typeof signInStatusSchema>

export function signInOutcome(state: z.infer<typeof signInStatusSchema>['state']): z.infer<typeof signInStatusSchema>['signIn'] {
  switch (state) {
    case 'active': return 'allowed'
    case 'paused': return 'resume-only'
    case 'closure-pending': return 'cancel-closure-only'
    case 'pending': return 'verification-only'
    default: return 'refused'
  }
}

export interface IdentityProvisioning {
  reserve(input: z.input<typeof provisioningReserveInputSchema>): Promise<z.infer<typeof provisioningReservationSchema>>
  confirm(input: z.input<typeof provisioningConfirmInputSchema>): Promise<z.infer<typeof provisionedIdentitySchema>>
  /** Always a `strong` read: sign-in must not depend on a cache. Null when unknown. */
  signInStatus(identityId: string): Promise<SignInStatus | null>
}
