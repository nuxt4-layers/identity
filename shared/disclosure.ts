import { z } from 'zod'
import { departurePolicySchema } from './group'
import { identifierSchema, instantSchema } from './identifiers'
import { MEMBERSHIP_KINDS, MEMBERSHIP_STATES } from './membership'
import type { DirectoryReadOptions } from './directory'

/**
 * The disclosure-context port Identity provides to Profile (docs/contracts.md
 * §9.3; iam-integration architecture §3).
 *
 * Profile decides what a viewer may see of a person. It needs two facts that
 * Identity owns: how the viewer is related to each subject, and, within a
 * group, that group's departure data policy. Identity supplies the facts;
 * Profile applies its own rules and the leaver's own anonymisation choice,
 * which Profile records. Whether the viewer is an administrator (to see a
 * suspended member, for example) is a question Profile asks Authorisation.
 *
 * Batched: one viewer, up to `DISCLOSURE_MAX_SUBJECTS` subjects, one optional
 * group context, so that a list of names costs one call.
 */

export const DISCLOSURE_MAX_SUBJECTS = 200

/**
 * The closest relationship that holds, in this order:
 *
 * - `self` — the viewer is the subject;
 * - `same-group` — with a group context: both hold a membership of it in
 *   effect. Without one: they share at least one standard group in which
 *   both memberships are in effect;
 * - `former-member` — with a group context: the subject's membership of it
 *   has ended and the viewer's is in effect. Profile applies the departure
 *   data policy;
 * - `same-tenant` — both hold memberships in effect in the same tenant;
 * - `none`.
 *
 * Personal groups never make two identities related. If the viewer holds no
 * membership in effect in the group context, the context is ignored: the
 * answer then says nothing about that group.
 */
export const RELATIONSHIPS = ['self', 'same-group', 'former-member', 'same-tenant', 'none'] as const
export type Relationship = typeof RELATIONSHIPS[number]

/**
 * How the subject's own state bears on disclosure: `visible` (active),
 * `paused` (hidden from everyone), `suspended` (shown only to administrators
 * who need to know), `closing` (closure pending: hidden) or `gone` (closed,
 * or unknown).
 */
export const SUBJECT_STANDINGS = ['visible', 'paused', 'suspended', 'closing', 'gone'] as const

export const disclosureRequestSchema = z.strictObject({
  viewerId: identifierSchema,
  subjectIds: z.array(identifierSchema).min(1).max(DISCLOSURE_MAX_SUBJECTS),
  groupId: identifierSchema.nullable(),
})

export const disclosureSubjectSchema = z.strictObject({
  subjectId: identifierSchema,
  relationship: z.enum(RELATIONSHIPS),
  standing: z.enum(SUBJECT_STANDINGS),
  /** The subject's membership of the group context, when the viewer may know of it. */
  membershipInGroup: z.strictObject({
    kind: z.enum(MEMBERSHIP_KINDS),
    state: z.enum(MEMBERSHIP_STATES),
    endedAt: instantSchema.nullable(),
  }).nullable(),
})

export const disclosureContextSchema = z.strictObject({
  viewerId: identifierSchema,
  /** The group context actually applied: null when none was given or the viewer is not a member. */
  groupId: identifierSchema.nullable(),
  /** The group's departure data policy, when a group context applies. */
  departurePolicy: departurePolicySchema.nullable(),
  subjects: z.array(disclosureSubjectSchema),
  readAt: instantSchema,
})

export type DisclosureRequest = z.infer<typeof disclosureRequestSchema>
export type DisclosureContext = z.infer<typeof disclosureContextSchema>

/**
 * Normally read with `bounded` consistency. A failure rejects, and Profile
 * then shows no name rather than a stale one (architecture §3).
 */
export interface IdentityDisclosureContextPort {
  describe(request: DisclosureRequest, options: DirectoryReadOptions): Promise<DisclosureContext>
}

/** The standing for an identity state, as the port reports it. */
export function standingOf(state: string | null): z.infer<typeof disclosureSubjectSchema>['standing'] {
  switch (state) {
    case 'active': return 'visible'
    case 'paused': return 'paused'
    case 'suspended': return 'suspended'
    case 'closure-pending': return 'closing'
    default: return 'gone'
  }
}
