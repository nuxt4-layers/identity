import { z } from 'zod'
import { actorContextSchema } from './directory'
import { groupSchema, lineageSchema } from './group'
import { correlationIdSchema, identifierSchema, instantSchema } from './identifiers'
import { identityExternalIdSchema, identitySchema } from './identity'
import { storedSafeNameSchema } from './safe-names'
import { effectiveSafetyPeriodsSchema, safetyPeriodsSchema } from './safety-periods'
import { EFFECTIVE_STATUSES, membershipSchema } from './membership'
import type { IdentitySubject } from './ports'

/**
 * Identity's administration surface (docs/contracts.md §19): the answers its
 * `/api/identity/*` endpoints and read functions give, and the port through
 * which the host tells Identity who is asking.
 *
 * Every answer here is in `IDENTITY_DATA_SCHEMAS`, so the personal-data
 * contract test covers it: identifiers, states, codes, instants and group
 * names only.
 */

/** Where the layer's endpoints are mounted. */
export const IDENTITY_API_PREFIX = '/api/identity'

/**
 * Request header a client may send to carry its correlation identifier
 * (a UUID). Otherwise the endpoint issues one.
 */
export const IDENTITY_CORRELATION_HEADER = 'x-correlation-id'

/**
 * Subject-resolver port, supplied by the host from Authentication
 * (`getAuthenticatedPrincipal(event)`). `request` is the server's request
 * event, passed through untouched: Identity's contract names no HTTP
 * framework. Resolves null when nobody is signed in; rejects on failure.
 */
export interface IdentitySubjectResolver {
  resolve(request: unknown): Promise<IdentitySubject | null>
}

/** The signed-in identity's own view: its actor context and the groups it alone owns. */
export const selfViewSchema = z.strictObject({
  actor: actorContextSchema,
  /**
   * The names of the groups in `actor.memberships`, for the person's own
   * pages: they are members, so they may see them. Names never enter events
   * or the ports other members use.
   */
  groupNames: z.array(z.strictObject({ groupId: identifierSchema, name: storedSafeNameSchema })).max(1000),
  /** Groups of which this identity is the last active owner (pausing orphans them; closure needs a decision). */
  lastOwnerOf: z.array(identifierSchema).max(1000),
})

/** A group as an administrator sees it (`identity.groups:view`). */
export const groupViewSchema = z.strictObject({
  group: groupSchema,
  lineage: lineageSchema,
  /** The group's own safety periods, and those in force for it (§21). */
  safetyPeriods: z.strictObject({
    own: safetyPeriodsSchema,
    effective: effectiveSafetyPeriodsSchema,
    /** Whether this is the host's platform group, whose periods are the platform's. */
    isPlatformGroup: z.boolean(),
  }),
})

/** A member of a group, with what the membership confers now. */
export const groupMemberSchema = z.strictObject({
  membership: membershipSchema,
  effectiveStatus: z.enum(EFFECTIVE_STATUSES),
})

/** A page of a group's live memberships (`identity.memberships:view`), in membership order. */
export const groupMembersPageSchema = z.strictObject({
  groupId: identifierSchema,
  members: z.array(groupMemberSchema).max(200),
  /** Pass as `after` for the next page; null on the last. */
  nextCursor: identifierSchema.nullable(),
  readAt: instantSchema,
})

/**
 * Identity's part of a data-subject access request (iam-integration
 * data-subject requests): the identity, its external identifiers and every
 * membership, ended ones included. Opaque identifiers and states only.
 */
export const identityExportSchema = z.strictObject({
  identity: identitySchema,
  externalIds: z.array(identityExternalIdSchema).max(1000),
  memberships: z.array(membershipSchema).max(10000),
  exportedAt: instantSchema,
  correlationId: correlationIdSchema,
})

export type SelfView = z.infer<typeof selfViewSchema>
export type GroupView = z.infer<typeof groupViewSchema>
export type GroupMember = z.infer<typeof groupMemberSchema>
export type GroupMembersPage = z.infer<typeof groupMembersPageSchema>
export type IdentityExport = z.infer<typeof identityExportSchema>
