import { describe, expect, it } from 'vitest'
import type { SafetyPeriodLevels } from '../contracts'
import { DEFAULT_IDENTITY_POLICY, effectiveSafetyPeriods, refuseSafetyPeriods, safetyPeriodsSchema, waitOutHours } from '../contracts'

const host = DEFAULT_IDENTITY_POLICY
const levels = (overrides: Partial<SafetyPeriodLevels> = {}): SafetyPeriodLevels => ({ platform: null, root: null, group: {}, isPlatformGroup: false, ...overrides })

describe('safety periods', () => {
  it('takes the safest of platform, root group and group, and the grace period from the platform alone', () => {
    const effective = effectiveSafetyPeriods(host, levels({
      platform: { publishedDelayHighHours: 48, closureGraceDays: 40 },
      root: { publishedDelayHighHours: 96, approvalExpiryDays: 10 },
      group: { approvalExpiryDays: 3, closureGraceDays: 90 },
    }))
    expect(effective).toMatchObject({ publishedDelayHighHours: 96, approvalExpiryDays: 3, closureGraceDays: 40, publishedDelayCriticalHours: 168 })
  })

  it('refuses values beyond the hard bounds and unknown settings', () => {
    expect(safetyPeriodsSchema.safeParse({ publishedDelayCriticalHours: 71 }).success).toBe(false)
    expect(safetyPeriodsSchema.safeParse({ approvalExpiryDays: 15 }).success).toBe(false)
    expect(safetyPeriodsSchema.safeParse({ pendingConfirmationHours: 24 }).success).toBe(false)
  })

  it('lets only the platform make a period less safe, with a risk-treatment reference past the deployment', () => {
    expect(refuseSafetyPeriods({ host, levels: levels(), next: { publishedDelayHighHours: 48 }, reference: null })).toBe('safety-period-floor')
    expect(refuseSafetyPeriods({ host, levels: levels(), next: { closureGraceDays: 60 }, reference: null })).toBe('platform-only')
    expect(refuseSafetyPeriods({ host, levels: levels({ root: { approvalExpiryDays: 3 } }), next: { approvalExpiryDays: 5 }, reference: null })).toBe('safety-period-floor')
    expect(refuseSafetyPeriods({ host, levels: levels(), next: { publishedDelayHighHours: 96, approvalExpiryDays: 2 }, reference: null })).toBeNull()
    const platform = levels({ isPlatformGroup: true })
    expect(refuseSafetyPeriods({ host, levels: platform, next: { publishedDelayHighHours: 48 }, reference: null })).toBe('risk-treatment-required')
    expect(refuseSafetyPeriods({ host, levels: platform, next: { publishedDelayHighHours: 48 }, reference: 'RT-1' })).toBeNull()
  })

  it('waits out the old values for anything less safe, and not at all for something safer', () => {
    const current = effectiveSafetyPeriods(host, levels({ group: { orphanRecoveryDelayDays: 30 } }))
    expect(waitOutHours(current, { ...current, publishedDelayHighHours: 100 })).toBe(0)
    expect(waitOutHours(current, { ...current, approvalExpiryDays: 10 })).toBe(168)
    expect(waitOutHours(current, { ...current, orphanRecoveryDelayDays: 14 })).toBe(30 * 24)
    expect(waitOutHours(current, { ...current, recoveryHoldHours: 24 })).toBe(168)
  })
})
