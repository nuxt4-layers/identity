import { z } from 'zod'
import { identifierSchema, instantSchema, reasonCodeSchema, versionSchema } from './identifiers'
import type { IdentityState } from './identity'

/**
 * Memberships (docs/contracts.md §6; iam-integration state models §2, §2a).
 */

/**
 * - `member` — an ordinary member.
 * - `guest` — an outside collaborator: a restricted role (Authorisation
 *   applies the group's guest role) and an end date, renewable by a group
 *   administrator.
 */
export const MEMBERSHIP_KINDS = ['member', 'guest'] as const
export type MembershipKind = typeof MEMBERSHIP_KINDS[number]

export const MEMBERSHIP_STATES = ['active', 'paused', 'suspended', 'ended'] as const
export type MembershipState = typeof MEMBERSHIP_STATES[number]

/** Why a membership ended. A removal also records a reason code. */
export const MEMBERSHIP_END_REASONS = ['left', 'removed', 'expired', 'identity-closed', 'group-archived'] as const
export type MembershipEndReason = typeof MEMBERSHIP_END_REASONS[number]

export const membershipSchema = z.strictObject({
  membershipId: identifierSchema,
  identityId: identifierSchema,
  groupId: identifierSchema,
  tenantId: identifierSchema,
  kind: z.enum(MEMBERSHIP_KINDS),
  state: z.enum(MEMBERSHIP_STATES),
  /** An owner of the group. Ownership is recorded here; Authorisation holds the `owner` role. */
  owner: z.boolean(),
  /** The member who created the group. Provenance only: it confers nothing (ADR-0005 §2.3). */
  foundingOwner: z.boolean(),
  /** The membership confers nothing before this instant (scheduled joiners). */
  startsAt: instantSchema,
  /** The membership ends at this instant (scheduled leavers, contractors, guests). Required for guests. */
  endsAt: instantSchema.nullable(),
  /** When it was recorded `ended`. */
  endedAt: instantSchema.nullable(),
  endReason: z.enum(MEMBERSHIP_END_REASONS).nullable(),
  /** For removal and suspension: the reason code. */
  reasonCode: reasonCodeSchema.nullable(),
  createdAt: instantSchema,
  version: versionSchema,
}).superRefine((membership, context) => {
  if (membership.kind === 'guest' && membership.endsAt === null) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'A guest membership has an end date' })
  }
  if (membership.kind === 'guest' && membership.owner) {
    context.addIssue({ code: 'custom', path: ['owner'], message: 'A guest cannot be an owner' })
  }
  if (membership.endsAt !== null && Date.parse(membership.endsAt) <= Date.parse(membership.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'A membership ends after it starts' })
  }
  const ended = membership.state === 'ended'
  if (ended ? (membership.endedAt === null || membership.endReason === null) : (membership.endedAt !== null || membership.endReason !== null)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'An ended membership records when and why, and only an ended one does' })
  }
  if (membership.foundingOwner && membership.kind !== 'member') {
    context.addIssue({ code: 'custom', path: ['foundingOwner'], message: 'The founding owner is a member' })
  }
})

export type MembershipRecord = z.infer<typeof membershipSchema>

// ---------------------------------------------------------------------------
// Effective status: what a membership confers now
// ---------------------------------------------------------------------------

/**
 * A membership's effective status at an instant, combining its own state,
 * its dates and its identity's state. Identity computes it, because the
 * rules that combine them are Identity's:
 *
 * - `not-started` — before `startsAt`; confers nothing and is left out of
 *   directory answers.
 * - `ended` — recorded `ended`, or past `endsAt` (even before the sweeper
 *   records it), or its identity is `closed`.
 * - `suspended` — its own state, or its identity is `suspended`,
 *   `closure-pending` or `pending` (none of which confers any access).
 * - `paused` — its own state, or its identity is `paused` (state models §2 rule 2).
 * - `active` — otherwise.
 *
 * The most restrictive applies: ended, then suspended, then paused.
 */
export const EFFECTIVE_STATUSES = ['active', 'paused', 'suspended', 'ended', 'not-started'] as const
export type EffectiveStatus = typeof EFFECTIVE_STATUSES[number]

export function effectiveStatus(
  membership: Pick<MembershipRecord, 'state' | 'startsAt' | 'endsAt'>,
  identityState: IdentityState,
  now: Date,
): EffectiveStatus {
  const at = now.getTime()
  if (membership.state === 'ended' || identityState === 'closed') return 'ended'
  if (membership.endsAt !== null && at >= Date.parse(membership.endsAt)) return 'ended'
  if (at < Date.parse(membership.startsAt)) return 'not-started'
  if (membership.state === 'suspended' || identityState === 'suspended' || identityState === 'closure-pending' || identityState === 'pending') return 'suspended'
  if (membership.state === 'paused' || identityState === 'paused') return 'paused'
  return 'active'
}

/** Membership transitions a member or administrator may request. Anything else is refused. */
export const MEMBERSHIP_TRANSITIONS = Object.freeze([
  { action: 'pause', from: ['active'], to: 'paused', by: 'self' },
  { action: 'resume', from: ['paused'], to: 'active', by: 'self' },
  { action: 'suspend', from: ['active', 'paused'], to: 'suspended', by: 'administrator' },
  { action: 'reinstate', from: ['suspended'], to: 'active', by: 'administrator' },
  { action: 'leave', from: ['active', 'paused', 'suspended'], to: 'ended', by: 'self' },
  { action: 'remove', from: ['active', 'paused', 'suspended'], to: 'ended', by: 'administrator' },
] as const)

/**
 * Whether `action` is refused because the membership belongs to a personal
 * group (which follows its identity) or would leave a group without an
 * active owner (ADR-0005 §2.3).
 */
export function refusedByGovernance(input: {
  action: 'pause' | 'suspend' | 'leave' | 'remove' | 'step-down'
  groupKind: 'personal' | 'standard'
  isOwner: boolean
  otherActiveOwners: number
}): 'personal-group' | 'last-owner' | null {
  if (input.groupKind === 'personal') return 'personal-group'
  if (input.isOwner && input.otherActiveOwners === 0) return 'last-owner'
  return null
}
