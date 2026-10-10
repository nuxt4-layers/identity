import { z } from 'zod'
import { GOVERNANCE_CHANGE_TYPES } from './approvals'
import type { GovernanceChangeType } from './approvals'
import { GROUP_KINDS, GROUP_RECORD_STATES, groupSettingsSchema } from './group'
import { identifierSchema, instantSchema, reasonCodeSchema, registryCodeSchema, versionSchema } from './identifiers'
import { MEMBERSHIP_END_REASONS, MEMBERSHIP_KINDS, MEMBERSHIP_STATES } from './membership'
import { IDENTITY_RISK_LEVELS } from './permissions'
import { storedSafeNameSchema } from './safe-names'
import { TENANT_STATES } from './tenant'

/**
 * End of life (docs/contracts.md §22; iam-integration's group deletion,
 * tenant lifecycle and retention processes).
 *
 * Identity keeps the legal holds on groups and tenants (Profile keeps those
 * on people), tracks each member's confirmation that it has disposed of a
 * deleted group's or closed tenant's information, and gives the root
 * groups' owners a closing tenant's governance records. Identifiers, codes,
 * instants and safe group names only.
 */

/** What Identity's legal holds cover: a group, or a whole tenant (every group in it, personal groups included). */
export const LEGAL_HOLD_SUBJECT_KINDS = ['group', 'tenant'] as const
export type LegalHoldSubjectKind = typeof LEGAL_HOLD_SUBJECT_KINDS[number]

/** The longest a hold may run; a longer one is a new hold. */
export const LEGAL_HOLD_MAX_DAYS = 2557

export const LEGAL_HOLD_STATES = ['active', 'ended'] as const

export const legalHoldSchema = z.strictObject({
  holdId: identifierSchema,
  subjectKind: z.enum(LEGAL_HOLD_SUBJECT_KINDS),
  subjectId: identifierSchema,
  /** The subject's tenant: the tenant itself for a tenant hold. */
  tenantId: identifierSchema,
  reasonCode: reasonCodeSchema,
  placedAt: instantSchema,
  endsAt: instantSchema,
  state: z.enum(LEGAL_HOLD_STATES),
  endedAt: instantSchema.nullable(),
  /** `expired` at its end date, or `released` by an approved change. */
  endedHow: z.enum(['expired', 'released']).nullable(),
  /** The approved change that placed it. */
  changeId: identifierSchema,
  version: versionSchema,
})

export type LegalHold = z.infer<typeof legalHoldSchema>

/** A disposal's subject. */
export const DISPOSAL_SUBJECT_KINDS = LEGAL_HOLD_SUBJECT_KINDS

/**
 * - `deferred` — a legal hold covers the subject; nothing is disposed of yet.
 * - `due` — every member disposes of its part and confirms it.
 */
export const DISPOSAL_STATES = ['deferred', 'due'] as const

/** Days a due disposal may wait for a member's confirmation before Identity raises it, and between reminders. */
export const DISPOSAL_CONFIRMATION_DAYS = 7

/** A member's name, as the prefix of its events (`authorisation`, `profile`, a domain capability's). */
export const disposalMemberSchema = registryCodeSchema

export const disposalSchema = z.strictObject({
  subjectKind: z.enum(DISPOSAL_SUBJECT_KINDS),
  subjectId: identifierSchema,
  tenantId: identifierSchema,
  state: z.enum(DISPOSAL_STATES),
  deletedAt: instantSchema,
  /** When disposal fell due: at deletion, or when the last hold covering it ended. */
  dueAt: instantSchema.nullable(),
  /** Members that have confirmed their part, Identity's own (`identity`) included. */
  confirmedBy: z.array(disposalMemberSchema).max(64),
  /** When Identity last raised it as overdue. */
  escalatedAt: instantSchema.nullable(),
})

export type Disposal = z.infer<typeof disposalSchema>

// ---------------------------------------------------------------------------
// A closing tenant's governance export
// ---------------------------------------------------------------------------

/** Most records of each kind in one export; a larger tenant is exported by the operator's procedure. */
export const TENANT_EXPORT_MAX_RECORDS = 100_000

/**
 * Identity's part of a closing tenant's governance export: what was
 * decided about its groups, never about a person. Personal groups and the
 * memberships of people in them are left out.
 */
export const tenantExportSchema = z.strictObject({
  tenant: z.strictObject({
    tenantId: identifierSchema,
    state: z.enum(TENANT_STATES),
    jurisdiction: registryCodeSchema,
    dataRegion: registryCodeSchema,
    createdAt: instantSchema,
    closesAt: instantSchema.nullable(),
  }),
  groups: z.array(z.strictObject({
    groupId: identifierSchema,
    parentGroupId: identifierSchema.nullable(),
    kind: z.enum(GROUP_KINDS),
    /** Null once a deleted group's disposal is due. */
    name: storedSafeNameSchema.nullable(),
    state: z.enum(GROUP_RECORD_STATES),
    settings: groupSettingsSchema.nullable(),
    createdAt: instantSchema,
  })).max(TENANT_EXPORT_MAX_RECORDS),
  memberships: z.array(z.strictObject({
    membershipId: identifierSchema,
    identityId: identifierSchema,
    groupId: identifierSchema,
    kind: z.enum(MEMBERSHIP_KINDS),
    state: z.enum(MEMBERSHIP_STATES),
    owner: z.boolean(),
    startsAt: instantSchema,
    endsAt: instantSchema.nullable(),
    endedAt: instantSchema.nullable(),
    endReason: z.enum(MEMBERSHIP_END_REASONS).nullable(),
  })).max(TENANT_EXPORT_MAX_RECORDS),
  changes: z.array(z.strictObject({
    changeId: identifierSchema,
    type: z.enum(GOVERNANCE_CHANGE_TYPES as [GovernanceChangeType, ...GovernanceChangeType[]]),
    groupId: identifierSchema,
    requesterId: identifierSchema,
    beneficiaryId: identifierSchema.nullable(),
    risk: z.enum(IDENTITY_RISK_LEVELS),
    reasonCode: reasonCodeSchema,
    state: z.enum(['applied', 'rejected', 'expired', 'cancelled']),
    createdAt: instantSchema,
    decidedAt: instantSchema,
  })).max(TENANT_EXPORT_MAX_RECORDS),
})

export type TenantGovernanceExport = z.infer<typeof tenantExportSchema>

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** The kinds of record Identity's maintenance deletes once past their period, and the policy setting for each. */
export const IDENTITY_RETENTION_SCHEDULES = Object.freeze({
  outboxEvents: 'retentionOutboxDays',
  invitations: 'retentionInvitationDays',
  acceptanceAttempts: 'retentionInvitationDays',
  joinRequests: 'retentionJoinRequestDays',
  governanceChanges: 'retentionGovernanceChangeDays',
  breakGlassReviews: 'retentionBreakGlassReviewDays',
} as const)

export type IdentityRetentionKind = keyof typeof IDENTITY_RETENTION_SCHEDULES

export const retentionCountsSchema = z.strictObject(
  Object.fromEntries(Object.keys(IDENTITY_RETENTION_SCHEDULES).map(kind => [kind, z.number().int().min(0)])) as { [K in IdentityRetentionKind]: z.ZodNumber },
)

export type RetentionCounts = z.infer<typeof retentionCountsSchema>
