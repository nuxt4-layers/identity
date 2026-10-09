import { describe, expect, it } from 'vitest'
import { DEFAULT_IDENTITY_POLICY, IDENTITY_POLICY_BOUNDS, loosenedSettings, resolveIdentityPolicy } from '../contracts'

describe('Identity policy', () => {
  it('uses the accepted process defaults (improvement register D3)', () => {
    expect(DEFAULT_IDENTITY_POLICY).toMatchObject({
      closureGraceDays: 30,
      pendingConfirmationHours: 24,
      approvalExpiryDays: 7,
      publishedDelayHighHours: 72,
      publishedDelayCriticalHours: 168,
      orphanRecoveryDelayDays: 14,
      recoveryHoldHours: 72,
      invitationExpiryDays: 14,
      guestTermDays: 90,
      maxHierarchyDepth: 10,
      riskTreatment: null,
    })
    expect(loosenedSettings(DEFAULT_IDENTITY_POLICY)).toEqual([])
  })

  it('lets a host tighten freely', () => {
    const policy = resolveIdentityPolicy({ closureGraceDays: 90, invitationExpiryDays: 7, publishedDelayCriticalHours: 336, guestTermDays: 30 })
    expect(policy.closureGraceDays).toBe(90)
    expect(policy.invitationExpiryDays).toBe(7)
  })

  it('refuses a loosening without a documented risk treatment, and accepts it with one', () => {
    expect(() => resolveIdentityPolicy({ publishedDelayHighHours: 24 })).toThrow(/publishedDelayHighHours/)
    expect(() => resolveIdentityPolicy({ invitationExpiryDays: 30 })).toThrow(/riskTreatment/)
    expect(resolveIdentityPolicy({ publishedDelayHighHours: 24, riskTreatment: 'RT-7' }).publishedDelayHighHours).toBe(24)
  })

  it('refuses values beyond the hard bounds even with a risk treatment', () => {
    for (const [key, bound] of Object.entries(IDENTITY_POLICY_BOUNDS)) {
      expect(() => resolveIdentityPolicy({ [key]: bound.min - 1, riskTreatment: 'RT-7' })).toThrow()
      expect(() => resolveIdentityPolicy({ [key]: bound.max + 1, riskTreatment: 'RT-7' })).toThrow()
    }
  })

  it('refuses unknown settings and malformed registry codes', () => {
    expect(() => resolveIdentityPolicy({ superuser: true } as never)).toThrow()
    expect(() => resolveIdentityPolicy({ jurisdictions: ['UK GDPR'] })).toThrow()
    expect(resolveIdentityPolicy({ jurisdictions: ['uk-gdpr', 'eu-gdpr'], dataRegions: ['uk', 'eu-west'] }).dataRegions).toEqual(['uk', 'eu-west'])
  })
})
