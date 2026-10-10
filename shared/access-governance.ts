import { z } from 'zod'
import { GROUP_KINDS, GROUP_STATES, requiredApproversSchema } from './group'
import { identifierSchema, instantSchema } from './identifiers'
import { IDENTITY_POLICY_BOUNDS } from './policy'

/**
 * The access-governance port Identity provides (docs/contracts.md §10.4;
 * iam-integration `docs/processes/access-administration.md`). Authorisation
 * records its own pending role and grant changes and applies the same
 * approval rules Identity applies to governance changes; this port gives it
 * Identity's facts to do so, through the host's adapter. Every read comes
 * from the source of truth (`strong`). It decides nothing and checks no
 * permission: identifiers, states, codes, numbers and instants only.
 */

/** The safety periods a change in Authorisation needs, as in force for the group (§21). */
export const ACCESS_GOVERNANCE_SAFETY_PERIODS = ['publishedDelayHighHours', 'publishedDelayCriticalHours', 'approvalExpiryDays', 'recoveryHoldHours'] as const

/** Most identities one requester is reported to control. */
export const ACCESS_GOVERNANCE_MAX_CONTROLS = 1000

export const governedGroupSchema = z.strictObject({
  groupId: identifierSchema,
  tenantId: identifierSchema,
  kind: z.enum(GROUP_KINDS),
  state: z.enum(GROUP_STATES),
  /** Null for a root group and for every personal group. */
  parentGroupId: identifierSchema.nullable(),
  /** The first group of the lineage: the group itself for a root or personal group. */
  rootGroupId: identifierSchema,
  /** For a personal group: whose it is. Null for a standard group. */
  personalOfIdentityId: identifierSchema.nullable(),
  /** The group's approval requirement; the defaults for a personal group. */
  approvals: z.strictObject({
    required: requiredApproversSchema,
    referenceRequired: z.boolean(),
  }),
  /** The values in force for the group: the platform's for a personal group. */
  safetyPeriods: z.strictObject(
    Object.fromEntries(ACCESS_GOVERNANCE_SAFETY_PERIODS.map((key) => {
      const bound = IDENTITY_POLICY_BOUNDS[key]
      return [key, z.number().int().min(bound.min).max(bound.max)]
    })) as { [K in typeof ACCESS_GOVERNANCE_SAFETY_PERIODS[number]]: z.ZodNumber },
  ),
  /** Facts about the identity named in the request: the requester of a change. */
  requester: z.strictObject({
    /** The end of the requester's recovery hold, if one is running now by the clock. */
    recoveryHoldUntil: instantSchema.nullable(),
    /** Identities the requester controls (service identities they created), which never approve for them. */
    controls: z.array(identifierSchema).max(ACCESS_GOVERNANCE_MAX_CONTROLS),
  }),
}).superRefine((group, context) => {
  const personal = group.kind === 'personal'
  if (personal && (group.parentGroupId !== null || group.rootGroupId !== group.groupId || group.personalOfIdentityId === null)) {
    context.addIssue({ code: 'custom', message: 'A personal group has no parent, is its own root and belongs to a person' })
  }
  if (!personal && group.personalOfIdentityId !== null) {
    context.addIssue({ code: 'custom', message: 'A standard group belongs to no person' })
  }
  if ((group.parentGroupId === null) !== (group.rootGroupId === group.groupId)) {
    context.addIssue({ code: 'custom', message: 'A group without a parent is its own root, and only then' })
  }
})

export type GovernedGroup = z.infer<typeof governedGroupSchema>

/**
 * Identity's access governance, for the host's adapter to Authorisation.
 * Server-only. Every read is `strong`. A failure rejects; it never answers
 * with partial data.
 */
export interface IdentityAccessGovernance {
  /**
   * The group's facts for one requester, or null for an unknown group. A
   * malformed identifier is `validation-failed`.
   */
  describeGroup(input: { groupId: string, identityId: string, correlationId: string }): Promise<GovernedGroup | null>
  /** Whether Identity records the identity as an owner of the group in effect now. */
  isOwner(input: { identityId: string, groupId: string }): Promise<boolean>
  /** How many owners of the group are in effect now, other than those listed. */
  countOwners(input: { groupId: string, excluding: readonly string[] }): Promise<number>
}
