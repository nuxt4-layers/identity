import { z } from 'zod'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema, versionSchema } from './identifiers'

/**
 * Identity's part of ADR-0007 (break-glass emergency access).
 *
 * A break-glass account is an identity of kind `break-glass`: no personal
 * group, no memberships, no roles. Identity tells Authentication, through the
 * provisioning port's sign-in status, that it may sign in with a passkey only.
 * It acts under its own identity and can do exactly the actions below, each
 * at once and without a second approver. Every use:
 *
 * - writes `break-glass.used`, which the host turns into an alert to every
 *   platform operator and every owner of the affected group or tenant;
 * - records a reason code and the correlation identifier;
 * - opens a review that only another person can close.
 *
 * It can never change roles, grants, policy, group structure or data, never
 * read a group's information, and never make itself an owner.
 */

export const BREAK_GLASS_ACTIONS = ['suspend-identity', 'suspend-membership', 'appoint-owner'] as const
export type BreakGlassAction = typeof BREAK_GLASS_ACTIONS[number]

export const BREAK_GLASS_REFUSALS = ['not-break-glass', 'not-permitted-action', 'group-not-orphaned', 'self-appointment', 'personal-group'] as const
export type BreakGlassRefusal = typeof BREAK_GLASS_REFUSALS[number]

/** Checks a break-glass action. Returns the refusal, or null when allowed. */
export function refuseBreakGlass(input: {
  actorKind: string
  action: string
  actorId: string
  /** For `appoint-owner`: the group's state and kind, and the identity appointed. */
  groupState?: 'active' | 'orphaned' | 'archived'
  groupKind?: 'personal' | 'standard'
  appointeeId?: string
}): BreakGlassRefusal | null {
  if (input.actorKind !== 'break-glass') return 'not-break-glass'
  if (!(BREAK_GLASS_ACTIONS as readonly string[]).includes(input.action)) return 'not-permitted-action'
  if (input.groupKind === 'personal') return 'personal-group'
  if (input.action === 'appoint-owner') {
    if (input.groupState !== 'orphaned') return 'group-not-orphaned'
    if (input.appointeeId === input.actorId) return 'self-appointment'
  }
  return null
}

export const breakGlassReviewSchema = z.strictObject({
  reviewId: identifierSchema,
  breakGlassIdentityId: identifierSchema,
  action: z.enum(BREAK_GLASS_ACTIONS),
  /** The identity, membership or group acted on. */
  targetId: identifierSchema,
  tenantId: identifierSchema.nullable(),
  reasonCode: reasonCodeSchema,
  correlationId: correlationIdSchema,
  usedAt: instantSchema,
  state: z.enum(['open', 'closed']),
  closedBy: identifierSchema.nullable(),
  closedAt: instantSchema.nullable(),
  /** The review's finding, as a code (`justified`, `unjustified-escalated`). */
  outcome: reasonCodeSchema.nullable(),
  version: versionSchema,
})

export type BreakGlassReview = z.infer<typeof breakGlassReviewSchema>

/**
 * A review is closed by a person other than the user of the account. The
 * break-glass identity can never close one; the host attests that the closer
 * did not hold its passkey for the action under review.
 */
export function mayCloseReview(review: Pick<BreakGlassReview, 'state' | 'breakGlassIdentityId'>, closerId: string, closerHeldPasskey: boolean): boolean {
  return review.state === 'open' && closerId !== review.breakGlassIdentityId && !closerHeldPasskey
}
