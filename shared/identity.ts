import { z } from 'zod'
import { externalIdSchema, identifierSchema, instantSchema, versionSchema } from './identifiers'

/**
 * Identities (docs/contracts.md §3; iam-integration state models §1).
 *
 * An identity is an opaque identifier for a person or a service. It is the
 * one identifier across the suite: Authentication's principal identifier,
 * Authorisation's subject identifier and Profile's record key.
 */

/**
 * - `person` — a human. Has exactly one personal group.
 * - `service` — a non-human principal owned by a group. No personal group.
 * - `break-glass` — an emergency account under ADR-0007: no personal group,
 *   no standing privileges, passkey-only sign-in, two actions only.
 */
export const IDENTITY_KINDS = ['person', 'service', 'break-glass'] as const
export type IdentityKind = typeof IDENTITY_KINDS[number]

/**
 * - `pending` — issued at sign-up, before Authentication has verified the
 *   sign-in identifier. Not in the directory, no access, no events. Becomes
 *   `active` when Authentication confirms, or is closed when the
 *   confirmation window ends.
 * - `active`, `paused`, `suspended`, `closure-pending`, `closed` — as in
 *   iam-integration's state models.
 */
export const IDENTITY_STATES = ['pending', 'active', 'paused', 'suspended', 'closure-pending', 'closed'] as const
export type IdentityState = typeof IDENTITY_STATES[number]

/** Who may cause a transition. `self` is the identity itself, after reauthentication where noted. */
export const IDENTITY_ACTORS = ['self', 'administrator', 'break-glass', 'system'] as const
export type IdentityActor = typeof IDENTITY_ACTORS[number]

export interface IdentityTransition {
  action: string
  from: readonly IdentityState[]
  to: IdentityState | 'previous'
  actors: readonly IdentityActor[]
}

/**
 * Every permitted identity transition. Anything not listed is refused.
 * `previous` restores the state held before the transition being undone.
 */
export const IDENTITY_TRANSITIONS: readonly IdentityTransition[] = Object.freeze([
  { action: 'confirm', from: ['pending'], to: 'active', actors: ['system'] },
  { action: 'expire', from: ['pending'], to: 'closed', actors: ['system'] },
  { action: 'pause', from: ['active'], to: 'paused', actors: ['self'] },
  { action: 'resume', from: ['paused'], to: 'active', actors: ['self'] },
  { action: 'suspend', from: ['active', 'paused'], to: 'suspended', actors: ['administrator', 'break-glass'] },
  { action: 'reinstate', from: ['suspended'], to: 'previous', actors: ['administrator'] },
  { action: 'request-closure', from: ['active', 'paused', 'suspended'], to: 'closure-pending', actors: ['self'] },
  { action: 'cancel-closure', from: ['closure-pending'], to: 'previous', actors: ['self'] },
  { action: 'close', from: ['closure-pending'], to: 'closed', actors: ['system'] },
])

export type IdentityAction = 'confirm' | 'expire' | 'pause' | 'resume' | 'suspend' | 'reinstate' | 'request-closure' | 'cancel-closure' | 'close'

/** The transition for `action` from `state` by `actor`, or null when refused. */
export function identityTransition(state: IdentityState, action: IdentityAction, actor: IdentityActor): IdentityTransition | null {
  const transition = IDENTITY_TRANSITIONS.find(candidate => candidate.action === action)
  if (!transition || !transition.from.includes(state) || !transition.actors.includes(actor)) return null
  return transition
}

/** The identity record as Identity publishes it. Opaque identifiers, states and instants only. */
export const identitySchema = z.strictObject({
  identityId: identifierSchema,
  kind: z.enum(IDENTITY_KINDS),
  state: z.enum(IDENTITY_STATES),
  /** For `suspended` and `closure-pending`: the state to restore. Null otherwise. */
  previousState: z.enum(['active', 'paused', 'suspended']).nullable(),
  /** The tenant whose jurisdiction and data region govern the personal group. */
  homeTenantId: identifierSchema,
  /** Null for service and break-glass identities. */
  personalGroupId: identifierSchema.nullable(),
  /** For a service identity: the group that owns it. Null otherwise. */
  ownerGroupId: identifierSchema.nullable(),
  createdAt: instantSchema,
  stateChangedAt: instantSchema,
  /** For `pending`: when the identity is closed unless confirmed. For `closure-pending`: when it closes. */
  deadlineAt: instantSchema.nullable(),
  version: versionSchema,
}).superRefine((identity, context) => {
  // A person's personal group is created on confirmation, so a `pending`
  // person, or one closed without ever being confirmed, has none yet.
  const unconfirmed = identity.state === 'pending' || (identity.state === 'closed' && identity.personalGroupId === null)
  const needsGroup = identity.kind === 'person' && !unconfirmed
  if (identity.kind !== 'person' ? identity.personalGroupId !== null : needsGroup !== (identity.personalGroupId !== null)) {
    context.addIssue({ code: 'custom', path: ['personalGroupId'], message: 'A confirmed person has exactly one personal group; a pending person and other kinds have none' })
  }
  if ((identity.kind === 'service') !== (identity.ownerGroupId !== null)) {
    context.addIssue({ code: 'custom', path: ['ownerGroupId'], message: 'A service identity, and only a service identity, has an owner group' })
  }
})

export type IdentityRecord = z.infer<typeof identitySchema>

/**
 * SCIM `externalId` of an identity, per tenant (improvement register item
 * 5). Identities are global but provisioning clients are per tenant, so one
 * identity may carry a different external identifier in each.
 */
export const identityExternalIdSchema = z.strictObject({
  tenantId: identifierSchema,
  identityId: identifierSchema,
  externalId: externalIdSchema,
})

export type IdentityExternalId = z.infer<typeof identityExternalIdSchema>

/**
 * How recently the person must have authenticated to pause their identity,
 * request closure or cancel it ("after reauthentication").
 */
export const REAUTHENTICATION_MAX_AGE_SECONDS = 900

/** Identity states in which memberships may confer access (subject to their own state). */
export const SIGN_IN_STATES: readonly IdentityState[] = ['active', 'paused']
