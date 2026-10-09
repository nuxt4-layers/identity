import { describe, expect, it } from 'vitest'
import type { PendingChange } from '../contracts'
import {
  DEFAULT_GROUP_SETTINGS,
  DEFAULT_REQUIRED_APPROVERS,
  GOVERNANCE_CHANGE_TYPES,
  REQUESTABLE_CHANGE_TYPES,
  governanceRequestSchema,
  approvalRequirement,
  chooseRoute,
  lowersBelowFloor,
  pendingChangeSchema,
  refuseApproval,
  refuseBreakGlass,
  refuseRequest,
  mayCloseReview,
} from '../contracts'
import { CORRELATION_ID, NOW, uuidv7 } from './support/fixtures'

const requester = uuidv7()
const approver = uuidv7()
const beneficiary = uuidv7()
const digest = 'a'.repeat(64)
const now = new Date(NOW)

const strongAssurance = { level: 'aal2' as const, phishingResistant: true, authenticatedAt: '2026-10-09T11:55:00.000Z' }

function change(overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    changeId: uuidv7(),
    type: 'group.add-owner',
    tenantId: uuidv7(),
    groupId: uuidv7(),
    requesterId: requester,
    beneficiaryId: beneficiary,
    risk: 'critical',
    justification: { reasonCode: 'succession', reference: null },
    target: { membershipId: uuidv7() },
    createdId: null,
    requiredApprovals: 1,
    route: 'approvers',
    approvals: [],
    changeDigest: digest,
    delayEndsAt: null,
    expiresAt: '2026-10-16T12:00:00.000Z',
    state: 'awaiting-approval',
    correlationId: CORRELATION_ID,
    createdAt: NOW,
    decidedAt: null,
    version: 1,
    ...overrides,
  }
}

const approve = (overrides: Partial<Parameters<typeof refuseApproval>[0]> = {}) => refuseApproval({
  change: change(),
  approverId: approver,
  qualifies: true,
  controlledByRequester: false,
  assurance: strongAssurance,
  changeDigest: digest,
  now,
  ...overrides,
})

describe('pending governance changes', () => {
  it('record requester, beneficiary, risk, justification, approvals, expiry and correlation', () => {
    expect(pendingChangeSchema.safeParse(change()).success).toBe(true)
    const { justification: _omitted, ...withoutJustification } = change()
    expect(pendingChangeSchema.safeParse(withoutJustification).success).toBe(false)
    expect(pendingChangeSchema.safeParse(change({ justification: { reasonCode: 'Because I said so', reference: null } })).success).toBe(false)
  })

  it('bind the target to the change type', () => {
    expect(pendingChangeSchema.safeParse(change({ target: { groupId: uuidv7() } })).success).toBe(false)
    expect(pendingChangeSchema.safeParse(change({ type: 'group.archive', target: { groupId: uuidv7() }, beneficiaryId: null })).success).toBe(true)
    expect(pendingChangeSchema.safeParse(change({ type: 'group.appoint-owner' })).success).toBe(true)
    expect(pendingChangeSchema.safeParse(change({ type: 'group.appoint-owner', target: { groupId: uuidv7() } })).success).toBe(false)
  })

  it('accept each requestable change with its own target only, and a strict justification', () => {
    const justification = { reasonCode: 'restructure', reference: null }
    expect([...REQUESTABLE_CHANGE_TYPES].sort()).toEqual([...GOVERNANCE_CHANGE_TYPES].sort())
    expect(governanceRequestSchema.safeParse({ type: 'group.archive', target: { groupId: uuidv7() }, justification }).success).toBe(true)
    expect(governanceRequestSchema.safeParse({ type: 'group.archive', target: { membershipId: uuidv7() }, justification }).success).toBe(false)
    expect(governanceRequestSchema.safeParse({ type: 'group.archive', target: { groupId: uuidv7(), note: 'x' }, justification }).success).toBe(false)
    expect(governanceRequestSchema.safeParse({ type: 'group.appoint-owner', target: { membershipId: uuidv7() }, justification }).success).toBe(true)
    expect(governanceRequestSchema.safeParse({ type: 'group.unknown', target: { membershipId: uuidv7() }, justification }).success).toBe(false)
    expect(governanceRequestSchema.safeParse({ type: 'group.create-root', target: { tenantId: uuidv7(), name: 'Pay\u200Broll', firstOwnerId: uuidv7() }, justification }).success).toBe(false)
    // Approval requirements below the floor cannot even be expressed.
    const approvals = { required: { low: 0, medium: 0, high: 0, critical: 1 }, referenceRequired: false }
    expect(governanceRequestSchema.safeParse({ type: 'group.change-approvals', target: { groupId: uuidv7(), approvals }, justification }).success).toBe(false)
    // Settings changes never carry approval requirements.
    expect(governanceRequestSchema.safeParse({ type: 'group.change-settings', target: { groupId: uuidv7(), settings: DEFAULT_GROUP_SETTINGS }, justification }).success).toBe(false)
  })

  it('refuse a change without a reason code, or without a reference where the group requires one', () => {
    const base = { type: 'group.archive' as const, requesterId: requester, beneficiaryId: null, inRequestersPersonalGroup: false, reference: null, referenceRequired: false }
    expect(refuseRequest({ ...base, reasonCode: null })).toBe('justification-missing')
    expect(refuseRequest({ ...base, reasonCode: 'restructure', referenceRequired: true })).toBe('reference-missing')
    expect(refuseRequest({ ...base, reasonCode: 'restructure', reference: 'CHG-1', referenceRequired: true })).toBeNull()
  })
})

describe('no self-grant at any risk level', () => {
  it.each(['group.add-owner', 'group.appoint-owner', 'membership.reinstate', 'membership.schedule', 'identity.reinstate'] as const)(
    'refuses %s for oneself outside one\'s personal group',
    (type) => {
      expect(refuseRequest({ type, requesterId: requester, beneficiaryId: requester, inRequestersPersonalGroup: false, reasonCode: 'x', reference: null, referenceRequired: false })).toBe('self-grant')
    },
  )

  it('allows stepping down or acting on others', () => {
    expect(refuseRequest({ type: 'group.remove-owner', requesterId: requester, beneficiaryId: requester, inRequestersPersonalGroup: false, reasonCode: 'x', reference: null, referenceRequired: false })).toBeNull()
    expect(refuseRequest({ type: 'group.add-owner', requesterId: requester, beneficiaryId: beneficiary, inRequestersPersonalGroup: false, reasonCode: 'x', reference: null, referenceRequired: false })).toBeNull()
  })
})

describe('approvers', () => {
  it('accept a qualifying approver at the assurance the risk requires', () => {
    expect(approve()).toBeNull()
  })

  it('refuse the requester, the beneficiary, and identities the requester controls', () => {
    expect(approve({ approverId: requester })).toBe('own-request')
    expect(approve({ approverId: beneficiary })).toBe('beneficiary')
    expect(approve({ controlledByRequester: true })).toBe('controlled-by-requester')
  })

  it('refuse an approver whose qualifying role was removed after the request', () => {
    expect(approve({ qualifies: false })).toBe('not-qualified')
  })

  it('refuse an approval of a change that differs from what was approved', () => {
    expect(approve({ changeDigest: 'b'.repeat(64) })).toBe('change-differs')
  })

  it('refuse a critical approval without recent phishing-resistant aal2', () => {
    expect(approve({ assurance: { ...strongAssurance, phishingResistant: false } })).toBe('insufficient-assurance')
    expect(approve({ assurance: { ...strongAssurance, authenticatedAt: '2026-10-09T11:40:00.000Z' } })).toBe('insufficient-assurance')
    expect(approve({ assurance: { ...strongAssurance, level: 'aal1' } })).toBe('insufficient-assurance')
  })

  it('refuse a second decision by the same approver, and decisions on closed changes', () => {
    const decided = change({ approvals: [{ approverId: approver, decision: 'approve', decidedAt: NOW, assurance: strongAssurance, changeDigest: digest }] })
    expect(approve({ change: decided })).toBe('already-decided')
    expect(approve({ change: change({ state: 'expired' }) })).toBe('not-pending')
  })
})

describe('requirements and routes', () => {
  it('never lets a group lower the default, and lets it raise it', () => {
    expect(lowersBelowFloor({ ...DEFAULT_REQUIRED_APPROVERS, high: 0 as never })).toBe(true)
    expect(lowersBelowFloor({ ...DEFAULT_REQUIRED_APPROVERS, critical: 2 })).toBe(false)
    expect(approvalRequirement({ risk: 'high', inRequestersPersonalGroup: false, groupRequirement: { low: 0, medium: 0, high: 2, critical: 2 } }).approvers).toBe(2)
    expect(approvalRequirement({ risk: 'high', inRequestersPersonalGroup: false, groupRequirement: { low: 0, medium: 0, high: 0 as never, critical: 1 } }).approvers).toBe(1)
  })

  it('needs no approver in one\'s own personal group, including for sharing, but still requires step-up', () => {
    const sharing = approvalRequirement({ risk: 'high', inRequestersPersonalGroup: true, groupRequirement: null })
    expect(sharing.approvers).toBe(0)
    expect(sharing.stepUp.minimumLevel).toBe('aal2')
    const critical = approvalRequirement({ risk: 'critical', inRequestersPersonalGroup: true, groupRequirement: null })
    expect(critical.stepUp).toEqual({ minimumLevel: 'aal2', phishingResistant: true, maxAuthenticationAgeSeconds: 900 })
  })

  it('falls back to a parent owner, a tenant owner, then a published delay', () => {
    expect(chooseRoute({ approvers: 1, qualifyingInGroup: 1, parentOwners: 1, tenantOwners: 1 })).toBe('approvers')
    expect(chooseRoute({ approvers: 1, qualifyingInGroup: 0, parentOwners: 1, tenantOwners: 1 })).toBe('parent-owner')
    expect(chooseRoute({ approvers: 1, qualifyingInGroup: 0, parentOwners: 0, tenantOwners: 1 })).toBe('tenant-owner')
    expect(chooseRoute({ approvers: 1, qualifyingInGroup: 0, parentOwners: 0, tenantOwners: 0 })).toBe('published-delay')
    expect(chooseRoute({ approvers: 0, qualifyingInGroup: 0, parentOwners: 0, tenantOwners: 0 })).toBe('none')
  })
})

describe('break-glass (ADR-0007)', () => {
  const actorId = uuidv7()
  it('allows only the two actions, and only to a break-glass identity', () => {
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'suspend-identity', actorId })).toBeNull()
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'suspend-membership', actorId })).toBeNull()
    expect(refuseBreakGlass({ actorKind: 'person', action: 'suspend-identity', actorId })).toBe('not-break-glass')
    for (const action of ['reparent', 'add-owner', 'change-settings', 'read', 'grant']) {
      expect(refuseBreakGlass({ actorKind: 'break-glass', action, actorId })).toBe('not-permitted-action')
    }
  })

  it('appoints an owner only to an orphaned standard group, and never itself', () => {
    const appointeeId = uuidv7()
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'appoint-owner', actorId, groupState: 'orphaned', groupKind: 'standard', appointeeId })).toBeNull()
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'appoint-owner', actorId, groupState: 'active', groupKind: 'standard', appointeeId })).toBe('group-not-orphaned')
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'appoint-owner', actorId, groupState: 'orphaned', groupKind: 'standard', appointeeId: actorId })).toBe('self-appointment')
    expect(refuseBreakGlass({ actorKind: 'break-glass', action: 'appoint-owner', actorId, groupState: 'orphaned', groupKind: 'personal', appointeeId })).toBe('personal-group')
  })

  it('lets only another person close the review', () => {
    const review = { state: 'open' as const, breakGlassIdentityId: actorId }
    expect(mayCloseReview(review, uuidv7(), false)).toBe(true)
    expect(mayCloseReview(review, actorId, false)).toBe(false)
    expect(mayCloseReview(review, uuidv7(), true)).toBe(false)
    expect(mayCloseReview({ ...review, state: 'closed' }, uuidv7(), false)).toBe(false)
  })
})
