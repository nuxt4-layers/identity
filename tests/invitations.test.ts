import { describe, expect, it } from 'vitest'
import type { InvitationRecord } from '../contracts'
import { DEFAULT_GROUP_SETTINGS, groupSchema, invitationRequiresConfirmation, invitationSchema, refuseConfirmation } from '../contracts'
import { NOW, standardGroup, uuidv7 } from './support/fixtures'

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    invitationId: uuidv7(),
    groupId: uuidv7(),
    tenantId: uuidv7(),
    kind: 'guest',
    inviteeIdentityId: null,
    tokenDigest: 'c'.repeat(64),
    invitedBy: uuidv7(),
    createdAt: NOW,
    expiresAt: '2026-10-23T12:00:00.000Z',
    membershipStartsAt: null,
    membershipEndsAt: null,
    requiresConfirmation: true,
    state: 'open',
    acceptedBy: null,
    acceptedAt: null,
    confirmedBy: null,
    decidedAt: null,
    version: 1,
    ...overrides,
  }
}

describe('invitation acceptance confirmation (forwarded links)', () => {
  it('defaults to confirmation for guests and immediate acceptance for members', () => {
    expect(DEFAULT_GROUP_SETTINGS.joining.invitationAcceptance).toEqual({ member: 'immediate', guest: 'confirm' })
  })

  it('applies the group\'s setting by kind, but never to an invitation bound to an existing identity', () => {
    const acceptance = DEFAULT_GROUP_SETTINGS.joining.invitationAcceptance
    expect(invitationRequiresConfirmation({ acceptance, kind: 'guest', inviteeIdentityId: null })).toBe(true)
    expect(invitationRequiresConfirmation({ acceptance, kind: 'member', inviteeIdentityId: null })).toBe(false)
    expect(invitationRequiresConfirmation({ acceptance, kind: 'guest', inviteeIdentityId: uuidv7() })).toBe(false)
    expect(invitationRequiresConfirmation({ acceptance: { member: 'confirm', guest: 'confirm' }, kind: 'member', inviteeIdentityId: null })).toBe(true)
  })

  it('lets a group tighten members to confirmation, and refuses unknown modes', () => {
    const group = standardGroup()
    const joining = { ...group.settings!.joining, invitationAcceptance: { member: 'confirm', guest: 'confirm' } }
    expect(groupSchema.safeParse({ ...group, settings: { ...group.settings!, joining } }).success).toBe(true)
    const loose = { ...group.settings!.joining, invitationAcceptance: { member: 'immediate', guest: 'auto' } }
    expect(groupSchema.safeParse({ ...group, settings: { ...group.settings!, joining: loose } }).success).toBe(false)
  })

  it('records who accepted and who confirmed, never the same identity', () => {
    const acceptedBy = uuidv7()
    expect(invitationSchema.safeParse(invitation({ state: 'awaiting-confirmation', acceptedBy, acceptedAt: NOW })).success).toBe(true)
    expect(invitationSchema.safeParse(invitation({ state: 'accepted', acceptedBy, acceptedAt: NOW, confirmedBy: acceptedBy, decidedAt: NOW })).success).toBe(false)
    expect(invitationSchema.safeParse(invitation({ requiresConfirmation: false, state: 'awaiting-confirmation' })).success).toBe(false)
    expect(invitationSchema.safeParse(invitation({ inviteeIdentityId: uuidv7() })).success).toBe(false)
  })

  it('refuses confirming one\'s own acceptance, or an invitation not awaiting confirmation', () => {
    const acceptedBy = uuidv7()
    const awaiting = invitation({ state: 'awaiting-confirmation', acceptedBy, acceptedAt: NOW })
    expect(refuseConfirmation(awaiting, uuidv7())).toBeNull()
    expect(refuseConfirmation(awaiting, awaiting.invitedBy)).toBeNull()
    expect(refuseConfirmation(awaiting, acceptedBy)).toBe('own-acceptance')
    expect(refuseConfirmation(invitation(), uuidv7())).toBe('not-awaiting')
  })
})
