import { z } from 'zod'
import { GROUP_STATES, lineageSchema } from './group'
import { identifierSchema, instantSchema } from './identifiers'
import { IDENTITY_KINDS, IDENTITY_STATES } from './identity'
import { MEMBERSHIP_KINDS, MEMBERSHIP_STATES } from './membership'

/**
 * The directory port Identity provides (docs/contracts.md §9.2), in
 * Identity's own vocabulary. The host adapts it to Authorisation's
 * `AuthorisationDirectory`; the reference adapter in iam-integration maps an
 * effective status of `paused` to `suspended` for Authorisation contract 2
 * and passes it through for contract 3. Identity's contract does not change
 * when Authorisation's does.
 */

/**
 * - `strong` — from the source of truth, never cached. Used for `high` and
 *   `critical` permissions, and for every governance check.
 * - `bounded` — may come from a cache no older than `IDENTITY_MAX_STALENESS_SECONDS`.
 */
export const DIRECTORY_CONSISTENCIES = ['strong', 'bounded'] as const
export type DirectoryConsistency = typeof DIRECTORY_CONSISTENCIES[number]

/** Upper bound on the age of a `bounded` answer; equal to Authorisation's. */
export const IDENTITY_MAX_STALENESS_SECONDS = 30

export interface DirectoryReadOptions {
  consistency: DirectoryConsistency
}

export const groupDescriptionSchema = z.strictObject({
  groupId: identifierSchema,
  tenantId: identifierSchema,
  /** Root first, ending with the group itself. One tenant throughout. */
  lineage: lineageSchema,
  kind: z.enum(['personal', 'standard']),
  state: z.enum(GROUP_STATES),
}).refine(group => group.lineage.at(-1) === group.groupId, 'The lineage ends with the group itself')

export type GroupDescription = z.infer<typeof groupDescriptionSchema>

export const directoryMembershipSchema = z.strictObject({
  membershipId: identifierSchema,
  group: groupDescriptionSchema,
  kind: z.enum(MEMBERSHIP_KINDS),
  /** The membership's own state. */
  state: z.enum(MEMBERSHIP_STATES).exclude(['ended']),
  /** What it confers now, combining state, dates and the identity's state (`effectiveStatus`). */
  effectiveStatus: z.enum(['active', 'paused', 'suspended']),
  owner: z.boolean(),
  startsAt: instantSchema,
  endsAt: instantSchema.nullable(),
})

export type DirectoryMembership = z.infer<typeof directoryMembershipSchema>

export const actorContextSchema = z.strictObject({
  identityId: identifierSchema,
  kind: z.enum(IDENTITY_KINDS),
  identityState: z.enum(IDENTITY_STATES).exclude(['pending']),
  /** Null for identities that have none (service and break-glass). */
  personalGroup: groupDescriptionSchema.nullable(),
  /**
   * Memberships in effect now: those whose effective status is `active`,
   * `paused` or `suspended`. Ended, expired and not-yet-started memberships
   * are left out, so their absence confers nothing.
   */
  memberships: z.array(directoryMembershipSchema),
  /** When this answer was read from the source of truth. */
  readAt: instantSchema,
})

export type ActorContext = z.infer<typeof actorContextSchema>

/**
 * Both methods honour `options.consistency`. A failure rejects; it never
 * answers with partial data, with data older than the consistency allows, or
 * with null in place of an error. Null means unknown (or `pending`).
 */
export interface IdentityDirectory {
  resolveActor(identityId: string, options: DirectoryReadOptions): Promise<ActorContext | null>
  describeGroup(groupId: string, options: DirectoryReadOptions): Promise<GroupDescription | null>
}
