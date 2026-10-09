import { describe, expect, it } from 'vitest'
import {
  effectiveStatus,
  groupSchema,
  identitySchema,
  identityTransition,
  membershipSchema,
  refusedByGovernance,
  signInOutcome,
  scimActive,
  wouldCreateCycle,
} from '../contracts'
import { membership, person, standardGroup, uuidv7 } from './support/fixtures'

const at = (iso: string) => new Date(iso)

describe('identity states', () => {
  it('lets only the person pause and resume, and nobody else', () => {
    expect(identityTransition('active', 'pause', 'self')).not.toBeNull()
    expect(identityTransition('active', 'pause', 'administrator')).toBeNull()
    expect(identityTransition('paused', 'resume', 'administrator')).toBeNull()
  })

  it('lets administrators and break-glass suspend, but only administrators reinstate', () => {
    expect(identityTransition('active', 'suspend', 'administrator')).not.toBeNull()
    expect(identityTransition('paused', 'suspend', 'break-glass')).not.toBeNull()
    expect(identityTransition('suspended', 'reinstate', 'break-glass')).toBeNull()
    expect(identityTransition('suspended', 'reinstate', 'self')).toBeNull()
  })

  it('makes a pending identity active only by confirmation, and closes it on expiry', () => {
    expect(identityTransition('pending', 'confirm', 'system')?.to).toBe('active')
    expect(identityTransition('pending', 'expire', 'system')?.to).toBe('closed')
    expect(identityTransition('pending', 'pause', 'self')).toBeNull()
  })

  it('never reopens a closed identity', () => {
    for (const action of ['confirm', 'resume', 'reinstate', 'cancel-closure', 'pause'] as const) {
      for (const actor of ['self', 'administrator', 'system', 'break-glass'] as const) {
        expect(identityTransition('closed', action, actor)).toBeNull()
      }
    }
  })

  it('lets only the person request or cancel closure', () => {
    expect(identityTransition('active', 'request-closure', 'administrator')).toBeNull()
    expect(identityTransition('closure-pending', 'cancel-closure', 'self')?.to).toBe('previous')
  })

  it('gives a person exactly one personal group, and other kinds none', () => {
    expect(identitySchema.safeParse(person()).success).toBe(true)
    expect(identitySchema.safeParse(person({ personalGroupId: null })).success).toBe(false)
    expect(identitySchema.safeParse(person({ state: 'pending', personalGroupId: null })).success).toBe(true)
    expect(identitySchema.safeParse(person({ state: 'pending' })).success).toBe(false)
    expect(identitySchema.safeParse(person({ state: 'closed', personalGroupId: null })).success).toBe(true)
    expect(identitySchema.safeParse(person({ kind: 'break-glass' })).success).toBe(false)
    expect(identitySchema.safeParse(person({ kind: 'break-glass', personalGroupId: null })).success).toBe(true)
    expect(identitySchema.safeParse(person({ kind: 'service', personalGroupId: null })).success).toBe(false)
    expect(identitySchema.safeParse(person({ kind: 'service', personalGroupId: null, ownerGroupId: uuidv7() })).success).toBe(true)
  })

  it('maps states to sign-in outcomes and SCIM active', () => {
    expect(signInOutcome('active')).toBe('allowed')
    expect(signInOutcome('paused')).toBe('resume-only')
    expect(signInOutcome('closure-pending')).toBe('cancel-closure-only')
    expect(signInOutcome('pending')).toBe('verification-only')
    expect(signInOutcome('suspended')).toBe('refused')
    expect(signInOutcome('closed')).toBe('refused')
    expect([scimActive('active'), scimActive('paused'), scimActive('suspended'), scimActive('pending')]).toEqual([true, true, false, false])
  })
})

describe('membership effective status', () => {
  const now = at('2026-10-09T12:00:00.000Z')

  it('confers nothing before it starts and ends at its end date, before any sweeper runs', () => {
    expect(effectiveStatus(membership({ startsAt: '2026-10-10T00:00:00.000Z' }), 'active', now)).toBe('not-started')
    expect(effectiveStatus(membership({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-10-09T12:00:00.000Z' }), 'active', now)).toBe('ended')
    expect(effectiveStatus(membership({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-10-09T12:00:00.001Z' }), 'active', now)).toBe('active')
  })

  it('pauses every membership of a paused identity, and restores each on resume', () => {
    expect(effectiveStatus(membership(), 'paused', now)).toBe('paused')
    expect(effectiveStatus(membership({ state: 'suspended' }), 'paused', now)).toBe('suspended')
    expect(effectiveStatus(membership({ state: 'suspended' }), 'active', now)).toBe('suspended')
  })

  it('confers nothing for suspended, closure-pending, pending or closed identities', () => {
    expect(effectiveStatus(membership(), 'suspended', now)).toBe('suspended')
    expect(effectiveStatus(membership(), 'closure-pending', now)).toBe('suspended')
    expect(effectiveStatus(membership(), 'pending', now)).toBe('suspended')
    expect(effectiveStatus(membership(), 'closed', now)).toBe('ended')
  })

  it('requires an end date for guests, and forbids guest owners', () => {
    expect(membershipSchema.safeParse(membership({ kind: 'guest' })).success).toBe(false)
    expect(membershipSchema.safeParse(membership({ kind: 'guest', endsAt: '2027-01-07T12:00:00.000Z' })).success).toBe(true)
    expect(membershipSchema.safeParse(membership({ kind: 'guest', endsAt: '2027-01-07T12:00:00.000Z', owner: true })).success).toBe(false)
  })

  it('records when and why a membership ended, and only for ended ones', () => {
    expect(membershipSchema.safeParse(membership({ state: 'ended' })).success).toBe(false)
    expect(membershipSchema.safeParse(membership({ state: 'ended', endedAt: '2026-10-09T12:00:00.000Z', endReason: 'left' })).success).toBe(true)
    expect(membershipSchema.safeParse(membership({ endReason: 'left' })).success).toBe(false)
  })

  it('refuses leaving or pausing a personal group, and losing the last owner', () => {
    expect(refusedByGovernance({ action: 'leave', groupKind: 'personal', isOwner: true, otherActiveOwners: 0 })).toBe('personal-group')
    expect(refusedByGovernance({ action: 'remove', groupKind: 'standard', isOwner: true, otherActiveOwners: 0 })).toBe('last-owner')
    expect(refusedByGovernance({ action: 'pause', groupKind: 'standard', isOwner: true, otherActiveOwners: 0 })).toBe('last-owner')
    expect(refusedByGovernance({ action: 'leave', groupKind: 'standard', isOwner: true, otherActiveOwners: 1 })).toBeNull()
    expect(refusedByGovernance({ action: 'leave', groupKind: 'standard', isOwner: false, otherActiveOwners: 0 })).toBeNull()
  })
})

describe('groups and the hierarchy', () => {
  it('keeps personal groups without parent, name or settings, and standard groups with both', () => {
    expect(groupSchema.safeParse(standardGroup()).success).toBe(true)
    expect(groupSchema.safeParse(standardGroup({ kind: 'personal' })).success).toBe(false)
    expect(groupSchema.safeParse(standardGroup({ kind: 'personal', name: null, settings: null })).success).toBe(true)
    expect(groupSchema.safeParse(standardGroup({ kind: 'personal', name: null, settings: null, state: 'orphaned' })).success).toBe(false)
    expect(groupSchema.safeParse(standardGroup({ name: null })).success).toBe(false)
  })

  it('refuses a group name that is not stored in its safe form', () => {
    expect(groupSchema.safeParse(standardGroup({ name: '  London   office ' })).success).toBe(false)
    expect(groupSchema.safeParse(standardGroup({ name: 'Lon​don' })).success).toBe(false)
  })

  it('detects a reparenting that would create a cycle', () => {
    expect(wouldCreateCycle('b', ['a', 'b', 'c'])).toBe(true)
    expect(wouldCreateCycle('b', ['a', 'c'])).toBe(false)
  })

  it('reserves the pause setting: any value but `allowed` is refused', () => {
    const group = standardGroup()
    expect(groupSchema.safeParse({ ...group, settings: { ...group.settings!, pausing: 'approval' } }).success).toBe(false)
  })
})
