import { z } from 'zod'
import { BREAK_GLASS_ACTIONS } from './break-glass'
import { GOVERNANCE_CHANGE_TYPES } from './approvals'
import type { GovernanceChangeType } from './approvals'
import { GROUP_KINDS, lineageSchema } from './group'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema, registryCodeSchema, versionSchema } from './identifiers'
import { IDENTITY_KINDS } from './identity'
import { MEMBERSHIP_END_REASONS, MEMBERSHIP_KINDS } from './membership'
import { IDENTITY_RISK_LEVELS } from './permissions'
import { disposalMemberSchema, LEGAL_HOLD_SUBJECT_KINDS, retentionCountsSchema } from './end-of-life'

/**
 * Identity's events (docs/contracts.md §11; iam-integration architecture §4).
 *
 * Each is written to Identity's transactional outbox in the same transaction
 * as the change, so it exists if and only if the change committed. The host
 * relays them. Delivery is at least once: consumers are idempotent by
 * `eventId` and ignore an `aggregate.version` older than the one they hold.
 *
 * Every event carries opaque identifiers, codes, instants and the
 * correlation identifier only: never a name, an address or free text.
 */

const id = identifierSchema
const membershipRef = { membershipId: id, identityId: id, groupId: id }

const payloads = {
  'identity.provisioned': z.strictObject({ identityId: id, kind: z.enum(IDENTITY_KINDS), homeTenantId: id, personalGroupId: id.nullable() }),
  'identity.provisioning-expired': z.strictObject({ identityId: id }),
  'identity.paused': z.strictObject({ identityId: id }),
  'identity.resumed': z.strictObject({ identityId: id }),
  'identity.suspended': z.strictObject({ identityId: id, reasonCode: reasonCodeSchema, changeId: id.nullable(), breakGlassReviewId: id.nullable() }),
  'identity.reinstated': z.strictObject({ identityId: id, changeId: id }),
  'identity.closure-requested': z.strictObject({ identityId: id, closesAt: instantSchema }),
  'identity.closure-cancelled': z.strictObject({ identityId: id }),
  'identity.closed': z.strictObject({ identityId: id, personalGroupId: id.nullable() }),
  'membership.added': z.strictObject({ ...membershipRef, kind: z.enum(MEMBERSHIP_KINDS), owner: z.boolean(), startsAt: instantSchema, endsAt: instantSchema.nullable() }),
  'membership.paused': z.strictObject(membershipRef),
  'membership.resumed': z.strictObject(membershipRef),
  'membership.suspended': z.strictObject({ ...membershipRef, reasonCode: reasonCodeSchema, changeId: id.nullable(), breakGlassReviewId: id.nullable() }),
  'membership.reinstated': z.strictObject({ ...membershipRef, changeId: id.nullable() }),
  'membership.dates-changed': z.strictObject({ ...membershipRef, startsAt: instantSchema, endsAt: instantSchema.nullable() }),
  'membership.ended': z.strictObject({ ...membershipRef, endReason: z.enum(MEMBERSHIP_END_REASONS), reasonCode: reasonCodeSchema.nullable() }),
  'group.created': z.strictObject({ groupId: id, lineage: lineageSchema, foundingOwnerId: id }),
  'group.renamed': z.strictObject({ groupId: id }),
  'group.reparented': z.strictObject({ groupId: id, previousLineage: lineageSchema, lineage: lineageSchema, changeId: id }),
  'group.owners-changed': z.strictObject({ groupId: id, added: z.array(id).max(64), removed: z.array(id).max(64), changeId: id.nullable(), breakGlassReviewId: id.nullable() }),
  'group.settings-changed': z.strictObject({ groupId: id, changed: z.array(z.enum(['joining', 'pausing', 'guests', 'approvals', 'onArchive', 'departure', 'safetyPeriods'])).min(1) }),
  'group.orphaned': z.strictObject({ groupId: id }),
  'group.recovered': z.strictObject({ groupId: id, changeId: id.nullable(), breakGlassReviewId: id.nullable() }),
  'group.archived': z.strictObject({ groupId: id, changeId: id }),
  'invitation.accepted': z.strictObject({ invitationId: id, groupId: id, invitedBy: id, acceptedBy: id, awaitingConfirmation: z.boolean() }),
  'invitation.refused': z.strictObject({ invitationId: id, groupId: id, refusedBy: id }),
  'join-request.created': z.strictObject({ joinRequestId: id, groupId: id, identityId: id }),
  'join-request.decided': z.strictObject({ joinRequestId: id, groupId: id, identityId: id, outcome: z.enum(['approved', 'refused', 'withdrawn', 'expired']) }),
  'tenant.created': z.strictObject({ tenantId: id, jurisdiction: registryCodeSchema, dataRegion: registryCodeSchema }),
  'tenant.closing': z.strictObject({ tenantId: id, closesAt: instantSchema }),
  'tenant.closing-cancelled': z.strictObject({ tenantId: id }),
  /** Every group in it deleted. `disposal` is `deferred` while a legal hold covers the tenant. */
  'tenant.closed': z.strictObject({ tenantId: id, disposal: z.enum(['due', 'deferred']) }),
  'tenant.disposal-due': z.strictObject({ tenantId: id }),
  'tenant.disposal-overdue': z.strictObject({ tenantId: id, members: z.array(disposalMemberSchema).min(1).max(64) }),
  /** An owner of a root group downloaded the closing tenant's governance records. */
  'tenant.exported': z.strictObject({ tenantId: id, requesterId: id }),
  /**
   * A deleted group confers nothing from now. `disposal` is `due` (every
   * member disposes of its part now) or `deferred` (a legal hold covers it;
   * `group.disposal-due` follows when the hold ends).
   */
  'group.deleted': z.strictObject({ groupId: id, tenantId: id, kind: z.enum(GROUP_KINDS), disposal: z.enum(['due', 'deferred']), changeId: id.nullable() }),
  'group.disposal-due': z.strictObject({ groupId: id, tenantId: id }),
  /** Members that have not confirmed a due disposal within 7 days, for operators. */
  'group.disposal-overdue': z.strictObject({ groupId: id, members: z.array(disposalMemberSchema).min(1).max(64) }),
  /** A person's home tenant is closing: they will be re-homed on `at`. For the host's notification capability. */
  'identity.rehoming-scheduled': z.strictObject({ identityId: id, tenantId: id, at: instantSchema }),
  'identity.rehoming-cancelled': z.strictObject({ identityId: id, tenantId: id }),
  /**
   * The identity's home tenant changed. Its personal group moved with it
   * (the same identifier) when the data regions match, or was replaced by a
   * new, empty one (and the old one deleted) when they differ.
   */
  'identity.rehomed': z.strictObject({ identityId: id, fromTenantId: id, toTenantId: id, previousPersonalGroupId: id.nullable(), personalGroupId: id.nullable() }),
  'legal-hold.placed': z.strictObject({ holdId: id, subjectKind: z.enum(LEGAL_HOLD_SUBJECT_KINDS), subjectId: id, reasonCode: reasonCodeSchema, endsAt: instantSchema, changeId: id }),
  'legal-hold.ended': z.strictObject({ holdId: id, subjectKind: z.enum(LEGAL_HOLD_SUBJECT_KINDS), subjectId: id, endedHow: z.enum(['expired', 'released']), changeId: id.nullable() }),
  /** One maintenance run's deletions under the retention schedules: counts only. */
  'identity.retention-applied': z.strictObject({ counts: retentionCountsSchema }),
  'approval.requested': z.strictObject({
    changeId: id,
    changeType: z.enum(GOVERNANCE_CHANGE_TYPES as [GovernanceChangeType, ...GovernanceChangeType[]]),
    groupId: id.nullable(),
    risk: z.enum(IDENTITY_RISK_LEVELS),
    route: z.enum(['approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'platform-operator']),
    requiredApprovals: z.number().int().min(0).max(2),
    delayEndsAt: instantSchema.nullable(),
  }),
  'approval.decided': z.strictObject({ changeId: id, outcome: z.enum(['applied', 'rejected', 'expired', 'cancelled']) }),
  /** A `critical` change requested within `recoveryHoldHours` of a credential recovery: it cannot apply before `heldUntil`. */
  'approval.held': z.strictObject({ changeId: id, groupId: id, heldUntil: instantSchema }),
  'break-glass.used': z.strictObject({ reviewId: id, breakGlassIdentityId: id, action: z.enum(BREAK_GLASS_ACTIONS), targetId: id, reasonCode: reasonCodeSchema }),
  'break-glass.review-closed': z.strictObject({ reviewId: id, closedBy: id, outcome: reasonCodeSchema }),
} as const

export type IdentityEventType = keyof typeof payloads
export const IDENTITY_EVENT_TYPES = Object.freeze(Object.keys(payloads) as IdentityEventType[])

export const IDENTITY_AGGREGATE_TYPES = ['identity', 'membership', 'group', 'invitation', 'join-request', 'tenant', 'approval', 'break-glass-review', 'legal-hold', 'retention'] as const

const envelope = {
  /** UUIDv7; consumers are idempotent by it. */
  eventId: id,
  occurredAt: instantSchema,
  correlationId: correlationIdSchema,
  /** The identity that caused the change, or null for the system (a sweeper, an expiry). */
  actorId: id.nullable(),
  aggregate: z.strictObject({ type: z.enum(IDENTITY_AGGREGATE_TYPES), id, version: versionSchema }),
  /** The tenant the change belongs to, or null for a global change to an identity. */
  tenantId: id.nullable(),
}

function eventSchema<T extends IdentityEventType>(type: T) {
  return z.strictObject({ ...envelope, type: z.literal(type), data: payloads[type] })
}

export const identityEventSchema = z.discriminatedUnion(
  'type',
  IDENTITY_EVENT_TYPES.map(type => eventSchema(type)) as unknown as [ReturnType<typeof eventSchema>, ...ReturnType<typeof eventSchema>[]],
)

export type IdentityEvent = {
  [T in IdentityEventType]: Omit<z.infer<ReturnType<typeof eventSchema<T>>>, 'data'> & { type: T, data: z.infer<(typeof payloads)[T]> }
}[IdentityEventType]

/** Per-type payload schemas, for consumers that validate one type. */
export const IDENTITY_EVENT_PAYLOADS: Readonly<Record<IdentityEventType, z.ZodType>> = Object.freeze(payloads)

/**
 * The lifecycle events Profile consumes (profile README; iam-integration
 * architecture §4): create the empty record, hide and show the person,
 * apply the departure data policy, and anonymise on closure.
 */
export const PROFILE_CONSUMED_EVENT_TYPES = Object.freeze([
  'identity.provisioned',
  'identity.paused',
  'identity.resumed',
  'identity.suspended',
  'identity.reinstated',
  'identity.closure-requested',
  'identity.closure-cancelled',
  'identity.closed',
  'membership.added',
  'membership.paused',
  'membership.resumed',
  'membership.suspended',
  'membership.reinstated',
  'membership.ended',
  'group.settings-changed',
  'group.deleted',
  'group.disposal-due',
  'identity.rehomed',
] as const satisfies readonly IdentityEventType[])

/** Events that must reach Authentication: it revokes sessions or discards a never-confirmed account. */
export const AUTHENTICATION_CONSUMED_EVENT_TYPES = Object.freeze([
  'identity.provisioning-expired',
  'identity.paused',
  'identity.suspended',
  'identity.closure-requested',
  'identity.closed',
] as const satisfies readonly IdentityEventType[])
