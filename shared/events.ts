import { z } from 'zod'
import { BREAK_GLASS_ACTIONS } from './break-glass'
import { GOVERNANCE_CHANGE_TYPES } from './approvals'
import type { GovernanceChangeType } from './approvals'
import { lineageSchema } from './group'
import { correlationIdSchema, identifierSchema, instantSchema, reasonCodeSchema, registryCodeSchema, versionSchema } from './identifiers'
import { IDENTITY_KINDS } from './identity'
import { MEMBERSHIP_END_REASONS, MEMBERSHIP_KINDS } from './membership'
import { IDENTITY_RISK_LEVELS } from './permissions'

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
  'group.settings-changed': z.strictObject({ groupId: id, changed: z.array(z.enum(['joining', 'pausing', 'guests', 'approvals', 'onArchive', 'departure'])).min(1) }),
  'group.orphaned': z.strictObject({ groupId: id }),
  'group.archived': z.strictObject({ groupId: id, changeId: id }),
  'tenant.created': z.strictObject({ tenantId: id, jurisdiction: registryCodeSchema, dataRegion: registryCodeSchema }),
  'tenant.closing': z.strictObject({ tenantId: id }),
  'approval.requested': z.strictObject({
    changeId: id,
    changeType: z.enum(GOVERNANCE_CHANGE_TYPES as [GovernanceChangeType, ...GovernanceChangeType[]]),
    groupId: id.nullable(),
    risk: z.enum(IDENTITY_RISK_LEVELS),
    route: z.enum(['approvers', 'parent-owner', 'tenant-owner', 'published-delay']),
    requiredApprovals: z.number().int().min(0).max(2),
    delayEndsAt: instantSchema.nullable(),
  }),
  'approval.decided': z.strictObject({ changeId: id, outcome: z.enum(['applied', 'rejected', 'expired', 'cancelled']) }),
  'break-glass.used': z.strictObject({ reviewId: id, breakGlassIdentityId: id, action: z.enum(BREAK_GLASS_ACTIONS), targetId: id, reasonCode: reasonCodeSchema }),
  'break-glass.review-closed': z.strictObject({ reviewId: id, closedBy: id, outcome: reasonCodeSchema }),
} as const

export type IdentityEventType = keyof typeof payloads
export const IDENTITY_EVENT_TYPES = Object.freeze(Object.keys(payloads) as IdentityEventType[])

export const IDENTITY_AGGREGATE_TYPES = ['identity', 'membership', 'group', 'tenant', 'approval', 'break-glass-review'] as const

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
] as const satisfies readonly IdentityEventType[])

/** Events that must reach Authentication: it revokes sessions or discards a never-confirmed account. */
export const AUTHENTICATION_CONSUMED_EVENT_TYPES = Object.freeze([
  'identity.provisioning-expired',
  'identity.paused',
  'identity.suspended',
  'identity.closure-requested',
  'identity.closed',
] as const satisfies readonly IdentityEventType[])
