import { z } from 'zod'
import {
  correlationIdSchema,
  identifierSchema,
  instantSchema,
  justificationReferenceSchema,
  reasonCodeSchema,
  sha256DigestSchema,
  versionSchema,
} from './identifiers'
import { IDENTITY_RISK_LEVELS } from './permissions'
import type { IdentityPermissionName, IdentityRiskLevel } from './permissions'
import { groupSettingsSchema } from './group'
import type { RequiredApprovers } from './group'
import { storedSafeNameSchema } from './safe-names'
import { safetyPeriodsSchema } from './safety-periods'

/**
 * Governance approvals (docs/contracts.md §8), following iam-integration's
 * `docs/processes/approvals.md`. Identity owns pending governance changes;
 * Authorisation owns pending role and grant changes.
 *
 * Rules every change obeys:
 *
 * 1. **No self-grant at any risk level.** Outside their own personal group,
 *    nobody makes a change that confers ownership, membership or a
 *    reinstatement on themselves.
 * 2. **Nobody approves their own request**, or a request of which they are
 *    the beneficiary, or through an identity the requester controls.
 * 3. A pending change records its requester, beneficiary, risk,
 *    justification (a reason code, and a reference where the group requires
 *    one), required approvals, expiry and correlation identifier.
 * 4. The approval is bound to a digest of the exact change. A change that
 *    differs from what was approved needs a new approval.
 * 5. **Personal-group sovereignty.** In their own personal group a person
 *    needs no approver, including to share what it owns, but must step up to
 *    the assurance the risk level sets.
 */

/** Governance changes Identity records, and the permission each exercises. */
export const GOVERNANCE_CHANGES = Object.freeze({
  'group.create-root': { permission: 'identity.root-groups:create', confers: false },
  'group.reparent': { permission: 'identity.groups:reparent', confers: false },
  'group.archive': { permission: 'identity.groups:archive', confers: false },
  'group.change-settings': { permission: 'identity.group-settings:manage', confers: false },
  'group.change-approvals': { permission: 'identity.group-approvals:manage', confers: false },
  'group.change-safety-periods': { permission: 'identity.group-approvals:manage', confers: false },
  'group.add-owner': { permission: 'identity.group-owners:manage', confers: true },
  'group.remove-owner': { permission: 'identity.group-owners:manage', confers: false },
  'group.suspend-owner': { permission: 'identity.group-owners:manage', confers: false },
  'group.appoint-owner': { permission: 'identity.orphaned-groups:recover', confers: true },
  'membership.reinstate': { permission: 'identity.memberships:suspend', confers: true },
  'membership.schedule': { permission: 'identity.memberships:schedule', confers: true },
  'identity.suspend': { permission: 'identity.identities:suspend', confers: false },
  'identity.reinstate': { permission: 'identity.identities:suspend', confers: true },
  'service-identity.create': { permission: 'identity.service-identities:create', confers: false },
} as const satisfies Record<string, { permission: IdentityPermissionName, confers: boolean }>)

export type GovernanceChangeType = keyof typeof GOVERNANCE_CHANGES
export const GOVERNANCE_CHANGE_TYPES = Object.keys(GOVERNANCE_CHANGES) as GovernanceChangeType[]

/**
 * How the requirement is met:
 * - `approvers` — qualifying principals in the group (or covering it);
 * - `parent-owner`, `tenant-owner` — the single-owner fallbacks;
 * - `published-delay` — no approver exists; the change applies when the delay ends unless cancelled;
 * - `platform-operator` — a member objected to an orphaned group's recovery during its delay; a
 *   qualifying member of the host's platform group decides;
 * - `none` — no approver needed (low or medium risk, or the requester's own personal group).
 */
export const APPROVAL_ROUTES = ['approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'platform-operator', 'none'] as const
export type ApprovalRoute = typeof APPROVAL_ROUTES[number]

export const PENDING_CHANGE_STATES = ['awaiting-approval', 'delayed', 'applied', 'rejected', 'expired', 'cancelled'] as const
export type PendingChangeState = typeof PENDING_CHANGE_STATES[number]

// ---------------------------------------------------------------------------
// What each change acts on
// ---------------------------------------------------------------------------

const id = identifierSchema
const onMembership = z.strictObject({ membershipId: id })
const onIdentity = z.strictObject({ identityId: id })

/**
 * The target of each change: what a requester submits, and what approvers
 * see and approve (its digest).
 */
export const GOVERNANCE_TARGETS = {
  /** A root group in `tenantId`, named `name`, with `firstOwnerId` as its founding owner. */
  'group.create-root': z.strictObject({ tenantId: id, name: storedSafeNameSchema, firstOwnerId: id }),
  /** Moves `groupId` under `parentGroupId` in the same tenant. */
  'group.reparent': z.strictObject({ groupId: id, parentGroupId: id }),
  'group.archive': z.strictObject({ groupId: id }),
  /** Every setting except `approvals`, which only `group.change-approvals` changes. */
  'group.change-settings': z.strictObject({ groupId: id, settings: groupSettingsSchema.omit({ approvals: true }) }),
  'group.change-approvals': z.strictObject({ groupId: id, approvals: groupSettingsSchema.shape.approvals }),
  /**
   * Replaces the group's own safety periods (§21); a missing setting defers
   * to the level above. Always `critical`; one that makes any period less
   * safe takes effect only after the old values have run.
   */
  'group.change-safety-periods': z.strictObject({ groupId: id, safetyPeriods: safetyPeriodsSchema }),
  /** Makes an active member (never a guest) an owner. */
  'group.add-owner': onMembership,
  /** Demotes an owner to a member. Never the last active owner. */
  'group.remove-owner': onMembership,
  /** Suspends an owner's membership, with the justification's reason code. Never the last active owner. */
  'group.suspend-owner': onMembership,
  'membership.reinstate': onMembership,
  /** Sets a membership's dates; renews a guest within the group's guest term. */
  'membership.schedule': z.strictObject({ membershipId: id, startsAt: instantSchema, endsAt: instantSchema.nullable() }),
  /** Platform-wide reasons only; decided in the host's platform group. */
  'identity.suspend': onIdentity,
  'identity.reinstate': onIdentity,
  /** A service identity owned by `groupId`. */
  'service-identity.create': z.strictObject({ groupId: id }),
  /**
   * Orphaned-group recovery: makes the active member holding `membershipId`
   * an owner of the orphaned group. Proposed by an owner of the parent group
   * or of the tenant's root group; where neither exists, by a member, for
   * the group's longest-standing active member, after a published delay any
   * member may object to.
   */
  'group.appoint-owner': onMembership,
} as const satisfies Partial<Record<GovernanceChangeType, z.ZodType>>

export type RequestableChangeType = keyof typeof GOVERNANCE_TARGETS
export const REQUESTABLE_CHANGE_TYPES = Object.keys(GOVERNANCE_TARGETS) as RequestableChangeType[]
export type GovernanceTarget<T extends RequestableChangeType = RequestableChangeType> = z.infer<typeof GOVERNANCE_TARGETS[T]>

export const justificationSchema = z.strictObject({
  reasonCode: reasonCodeSchema,
  reference: justificationReferenceSchema.nullable(),
})

function requestSchema<T extends RequestableChangeType>(type: T) {
  return z.strictObject({ type: z.literal(type), target: GOVERNANCE_TARGETS[type], justification: justificationSchema })
}

/** A governance change as a requester submits it. */
export const governanceRequestSchema = z.discriminatedUnion(
  'type',
  REQUESTABLE_CHANGE_TYPES.map(type => requestSchema(type)) as unknown as [ReturnType<typeof requestSchema>, ...ReturnType<typeof requestSchema>[]],
)

export type GovernanceRequest = {
  [T in RequestableChangeType]: { type: T, target: GovernanceTarget<T>, justification: z.infer<typeof justificationSchema> }
}[RequestableChangeType]

/** The target of any change, recorded on the pending change. */
export const governanceTargetSchema = z.union([
  GOVERNANCE_TARGETS['group.create-root'],
  GOVERNANCE_TARGETS['group.reparent'],
  GOVERNANCE_TARGETS['group.archive'],
  GOVERNANCE_TARGETS['group.change-settings'],
  GOVERNANCE_TARGETS['group.change-approvals'],
  GOVERNANCE_TARGETS['group.change-safety-periods'],
  onMembership,
  GOVERNANCE_TARGETS['membership.schedule'],
  onIdentity,
])

export const assuranceRecordSchema = z.strictObject({
  level: z.enum(['aal1', 'aal2']),
  phishingResistant: z.boolean(),
  authenticatedAt: instantSchema,
})

export const approvalRecordSchema = z.strictObject({
  approverId: identifierSchema,
  /** `object`: a member's objection to an orphaned group's recovery, which sends it to a platform operator. */
  decision: z.enum(['approve', 'reject', 'object']),
  decidedAt: instantSchema,
  assurance: assuranceRecordSchema,
  /** The digest of the change as the approver saw it. */
  changeDigest: sha256DigestSchema,
})

export const pendingChangeSchema = z.strictObject({
  changeId: identifierSchema,
  type: z.enum(GOVERNANCE_CHANGE_TYPES as [GovernanceChangeType, ...GovernanceChangeType[]]),
  tenantId: identifierSchema,
  groupId: identifierSchema.nullable(),
  requesterId: identifierSchema,
  /** The identity the change confers on or acts against. Null when it concerns only a group. */
  beneficiaryId: identifierSchema.nullable(),
  risk: z.enum(IDENTITY_RISK_LEVELS),
  justification: justificationSchema,
  /** What the change acts on (`GOVERNANCE_TARGETS`). */
  target: governanceTargetSchema,
  /** For a change that creates a group or a service identity: its identifier, issued when requested. */
  createdId: identifierSchema.nullable(),
  requiredApprovals: z.number().int().min(0).max(2),
  route: z.enum(APPROVAL_ROUTES),
  approvals: z.array(approvalRecordSchema).max(4),
  /**
   * SHA-256 of the change as recorded (type, tenant, group, requester,
   * beneficiary, risk, justification, target, created identifier), computed
   * by the database when the change is recorded and again before it is
   * applied. Approvals must match it.
   */
  changeDigest: sha256DigestSchema,
  /** For `published-delay`: when it applies. */
  delayEndsAt: instantSchema.nullable(),
  /** For `awaiting-approval`: when it expires unapplied. */
  expiresAt: instantSchema.nullable(),
  state: z.enum(PENDING_CHANGE_STATES),
  correlationId: correlationIdSchema,
  createdAt: instantSchema,
  /** When it was applied, rejected, expired or cancelled. */
  decidedAt: instantSchema.nullable(),
  version: versionSchema,
}).superRefine((change, context) => {
  const target = (GOVERNANCE_TARGETS as Partial<Record<GovernanceChangeType, z.ZodType>>)[change.type]
  if (!target || !target.safeParse(change.target).success) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'The target does not match the change type' })
  }
})

export type PendingChange = z.infer<typeof pendingChangeSchema>

// ---------------------------------------------------------------------------
// Assurance by risk (step-up)
// ---------------------------------------------------------------------------

export interface StepUpRequirement {
  minimumLevel: 'aal1' | 'aal2'
  phishingResistant: boolean
  /** Maximum seconds since the last authentication, or null for no limit. */
  maxAuthenticationAgeSeconds: number | null
}

/** What each risk level demands of the session, for requesters and approvers alike (approvals.md). */
export const STEP_UP_REQUIREMENTS: Readonly<Record<IdentityRiskLevel, StepUpRequirement>> = Object.freeze({
  low: { minimumLevel: 'aal1', phishingResistant: false, maxAuthenticationAgeSeconds: null },
  medium: { minimumLevel: 'aal1', phishingResistant: false, maxAuthenticationAgeSeconds: null },
  high: { minimumLevel: 'aal2', phishingResistant: false, maxAuthenticationAgeSeconds: null },
  critical: { minimumLevel: 'aal2', phishingResistant: true, maxAuthenticationAgeSeconds: 900 },
})

export function meetsStepUp(assurance: z.infer<typeof assuranceRecordSchema>, requirement: StepUpRequirement, now: Date): boolean {
  if (requirement.minimumLevel === 'aal2' && assurance.level !== 'aal2') return false
  if (requirement.phishingResistant && !assurance.phishingResistant) return false
  if (requirement.maxAuthenticationAgeSeconds !== null) {
    const age = (now.getTime() - Date.parse(assurance.authenticatedAt)) / 1000
    if (!(age >= 0 && age <= requirement.maxAuthenticationAgeSeconds)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface ApprovalRequirement {
  approvers: 0 | 1 | 2
  stepUp: StepUpRequirement
}

/**
 * What a change at `risk` requires. In the requester's own personal group:
 * no approver, but the step-up still applies. Elsewhere: the group's
 * requirement, which can never be below the default floor.
 */
export function approvalRequirement(input: {
  risk: IdentityRiskLevel
  inRequestersPersonalGroup: boolean
  groupRequirement: RequiredApprovers | null
}): ApprovalRequirement {
  const stepUp = STEP_UP_REQUIREMENTS[input.risk]
  if (input.inRequestersPersonalGroup) return { approvers: 0, stepUp }
  const floor = ({ low: 0, medium: 0, high: 1, critical: 1 } as const)[input.risk]
  const required = Math.max(floor, input.groupRequirement?.[input.risk] ?? floor) as 0 | 1 | 2
  return { approvers: required, stepUp }
}

export const REQUEST_REFUSALS = ['self-grant', 'justification-missing', 'reference-missing'] as const
export type RequestRefusal = typeof REQUEST_REFUSALS[number]

/** Checks a change before it is recorded. Returns the refusal, or null. */
export function refuseRequest(input: {
  type: GovernanceChangeType
  requesterId: string
  beneficiaryId: string | null
  inRequestersPersonalGroup: boolean
  reasonCode: string | null
  reference: string | null
  referenceRequired: boolean
}): RequestRefusal | null {
  if (GOVERNANCE_CHANGES[input.type].confers && input.beneficiaryId === input.requesterId && !input.inRequestersPersonalGroup) {
    return 'self-grant'
  }
  if (!input.reasonCode) return 'justification-missing'
  if (input.referenceRequired && !input.reference) return 'reference-missing'
  return null
}

export const APPROVAL_REFUSALS = [
  'own-request',
  'beneficiary',
  'controlled-by-requester',
  'not-qualified',
  'insufficient-assurance',
  'change-differs',
  'not-pending',
  'already-decided',
] as const
export type ApprovalRefusal = typeof APPROVAL_REFUSALS[number]

/**
 * Checks an approval at decision time. `qualifies` must be read from
 * Authorisation with `strong` consistency at that moment, so an approver
 * whose role was removed after the request is refused.
 */
export function refuseApproval(input: {
  change: Pick<PendingChange, 'requesterId' | 'beneficiaryId' | 'changeDigest' | 'state' | 'approvals' | 'risk'>
  approverId: string
  qualifies: boolean
  controlledByRequester: boolean
  assurance: z.infer<typeof assuranceRecordSchema>
  changeDigest: string
  now: Date
}): ApprovalRefusal | null {
  const { change } = input
  if (change.state !== 'awaiting-approval') return 'not-pending'
  if (input.approverId === change.requesterId) return 'own-request'
  if (input.approverId === change.beneficiaryId) return 'beneficiary'
  if (input.controlledByRequester) return 'controlled-by-requester'
  if (change.approvals.some(approval => approval.approverId === input.approverId)) return 'already-decided'
  if (!input.qualifies) return 'not-qualified'
  if (input.changeDigest !== change.changeDigest) return 'change-differs'
  if (!meetsStepUp(input.assurance, STEP_UP_REQUIREMENTS[change.risk], input.now)) return 'insufficient-assurance'
  return null
}

/**
 * The route for a change that needs approvers, given who could approve. The
 * fallbacks apply in order only when nobody but the requester qualifies in
 * the group itself.
 */
export function chooseRoute(input: {
  approvers: 0 | 1 | 2
  qualifyingInGroup: number
  parentOwners: number
  tenantOwners: number
}): ApprovalRoute {
  if (input.approvers === 0) return 'none'
  if (input.qualifyingInGroup >= input.approvers) return 'approvers'
  if (input.parentOwners > 0) return 'parent-owner'
  if (input.tenantOwners > 0) return 'tenant-owner'
  return 'published-delay'
}
