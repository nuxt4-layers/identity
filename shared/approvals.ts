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
import type { RequiredApprovers } from './group'

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
 * - `none` — no approver needed (low or medium risk, or the requester's own personal group).
 */
export const APPROVAL_ROUTES = ['approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'none'] as const
export type ApprovalRoute = typeof APPROVAL_ROUTES[number]

export const PENDING_CHANGE_STATES = ['awaiting-approval', 'delayed', 'applied', 'rejected', 'expired', 'cancelled'] as const

export const assuranceRecordSchema = z.strictObject({
  level: z.enum(['aal1', 'aal2']),
  phishingResistant: z.boolean(),
  authenticatedAt: instantSchema,
})

export const approvalRecordSchema = z.strictObject({
  approverId: identifierSchema,
  decision: z.enum(['approve', 'reject']),
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
  justification: z.strictObject({
    reasonCode: reasonCodeSchema,
    reference: justificationReferenceSchema.nullable(),
  }),
  requiredApprovals: z.number().int().min(0).max(2),
  route: z.enum(APPROVAL_ROUTES),
  approvals: z.array(approvalRecordSchema).max(4),
  /** SHA-256 of the canonical form of the change; approvals must match it. */
  changeDigest: sha256DigestSchema,
  /** For `published-delay`: when it applies. */
  delayEndsAt: instantSchema.nullable(),
  /** For `awaiting-approval`: when it expires unapplied. */
  expiresAt: instantSchema.nullable(),
  state: z.enum(PENDING_CHANGE_STATES),
  correlationId: correlationIdSchema,
  createdAt: instantSchema,
  version: versionSchema,
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
