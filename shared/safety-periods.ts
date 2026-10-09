import { z } from 'zod'
import { IDENTITY_POLICY_BOUNDS } from './policy'
import type { IdentityPolicyPeriods } from './policy'

/**
 * Safety periods (docs/contracts.md §21; iam-integration
 * `docs/processes/README.md`, Safety periods).
 *
 * The waits that protect people when nobody else can stop a change. The
 * host's policy gives each a starting value; while the platform runs:
 *
 * 1. the **platform group**'s owners may move a period in either direction
 *    within the hard bounds (past the host's value in the less safe
 *    direction only with a justification reference to a risk treatment);
 * 2. a **root group**'s owners may make it safer for every group under it;
 * 3. a **group**'s owners may make it safer for that group.
 *
 * The period that applies is the safest of the three. The closure grace
 * period is the person's, not a group's, so only the platform sets it.
 * Changing a period is a `critical` governance change, and one that makes
 * any period less safe waits out the old values (`waitOutHours`).
 */

export const SAFETY_PERIOD_SETTINGS = [
  'publishedDelayHighHours',
  'publishedDelayCriticalHours',
  'approvalExpiryDays',
  'orphanRecoveryDelayDays',
  'recoveryHoldHours',
  'closureGraceDays',
] as const

export type SafetyPeriodSetting = typeof SAFETY_PERIOD_SETTINGS[number]

/** Settings only the platform group sets: they belong to a person, not to a group. */
export const PLATFORM_ONLY_SAFETY_PERIODS: readonly SafetyPeriodSetting[] = Object.freeze(['closureGraceDays'])

/** Hours in one unit of each setting, to compare waits. */
const HOURS_PER_UNIT: Readonly<Record<SafetyPeriodSetting, number>> = Object.freeze({
  publishedDelayHighHours: 1,
  publishedDelayCriticalHours: 1,
  approvalExpiryDays: 24,
  orphanRecoveryDelayDays: 24,
  recoveryHoldHours: 1,
  closureGraceDays: 24,
})

/** What one level sets. A missing setting defers to the level above. */
export const safetyPeriodsSchema = z.strictObject(
  Object.fromEntries(SAFETY_PERIOD_SETTINGS.map((key) => {
    const bound = IDENTITY_POLICY_BOUNDS[key]
    return [key, z.number().int().min(bound.min).max(bound.max).optional()]
  })) as { [K in SafetyPeriodSetting]: z.ZodOptional<z.ZodNumber> },
)

export type SafetyPeriods = z.infer<typeof safetyPeriodsSchema>

/** The value in force for every setting. */
export const effectiveSafetyPeriodsSchema = z.strictObject(
  Object.fromEntries(SAFETY_PERIOD_SETTINGS.map((key) => {
    const bound = IDENTITY_POLICY_BOUNDS[key]
    return [key, z.number().int().min(bound.min).max(bound.max)]
  })) as { [K in SafetyPeriodSetting]: z.ZodNumber },
)

export type EffectiveSafetyPeriods = z.infer<typeof effectiveSafetyPeriodsSchema>

/** The levels that set a group's periods, as Identity reads them. */
export interface SafetyPeriodLevels {
  /** The platform group's own settings, or null when the host designates none. */
  platform: SafetyPeriods | null
  /** The group's root group's own settings, or null when the group is a root. */
  root: SafetyPeriods | null
  /** The group's own settings. */
  group: SafetyPeriods
  /** Whether the group is the platform group (its own settings are then the platform's). */
  isPlatformGroup: boolean
}

/** The safer of two values of `key`. */
export function saferValue(key: SafetyPeriodSetting, a: number, b: number): number {
  return IDENTITY_POLICY_BOUNDS[key].saferWhen === 'longer' ? Math.max(a, b) : Math.min(a, b)
}

/** True when `next` is less safe than `current`. */
export function lessSafe(key: SafetyPeriodSetting, next: number, current: number): boolean {
  return IDENTITY_POLICY_BOUNDS[key].saferWhen === 'longer' ? next < current : next > current
}

/** The platform's values: its own settings over the host's policy. */
export function platformSafetyPeriods(host: IdentityPolicyPeriods, platform: SafetyPeriods | null): EffectiveSafetyPeriods {
  return Object.fromEntries(SAFETY_PERIOD_SETTINGS.map(key => [key, platform?.[key] ?? host[key]])) as EffectiveSafetyPeriods
}

/**
 * The periods in force for a group: the safest of the platform's, its root
 * group's and its own. The closure grace period is the platform's alone.
 */
export function effectiveSafetyPeriods(host: IdentityPolicyPeriods, levels: SafetyPeriodLevels): EffectiveSafetyPeriods {
  const platform = platformSafetyPeriods(host, levels.isPlatformGroup ? levels.group : levels.platform)
  return Object.fromEntries(SAFETY_PERIOD_SETTINGS.map((key) => {
    if (PLATFORM_ONLY_SAFETY_PERIODS.includes(key)) return [key, platform[key]]
    let value = platform[key]
    for (const level of [levels.root, levels.group]) {
      const set = level?.[key]
      if (set !== undefined) value = saferValue(key, value, set)
    }
    return [key, value]
  })) as EffectiveSafetyPeriods
}

export const SAFETY_PERIOD_REFUSALS = ['platform-only', 'safety-period-floor', 'risk-treatment-required'] as const
export type SafetyPeriodRefusal = typeof SAFETY_PERIOD_REFUSALS[number]

/**
 * Checks a request to set a group's own periods to `next`. Outside the
 * platform group, no setting may be less safe than the levels above, and the
 * platform-only settings may not be set at all. In the platform group, a
 * setting less safe than the host's value needs a justification reference.
 */
export function refuseSafetyPeriods(input: {
  host: IdentityPolicyPeriods
  levels: SafetyPeriodLevels
  next: SafetyPeriods
  reference: string | null
}): SafetyPeriodRefusal | null {
  const { host, levels, next } = input
  for (const key of SAFETY_PERIOD_SETTINGS) {
    const value = next[key]
    if (value === undefined) continue
    if (levels.isPlatformGroup) {
      if (lessSafe(key, value, host[key]) && !input.reference) return 'risk-treatment-required'
      continue
    }
    if (PLATFORM_ONLY_SAFETY_PERIODS.includes(key)) return 'platform-only'
    const above = effectiveSafetyPeriods(host, { ...levels, group: {} })
    if (lessSafe(key, value, above[key])) return 'safety-period-floor'
  }
  return null
}

/**
 * How long a change of periods must wait once approved, counted from the
 * request: zero when nothing becomes less safe; otherwise the longer of the
 * current `critical` published delay and the current value of each delay it
 * shortens. A safer value waits for nothing.
 */
export function waitOutHours(current: EffectiveSafetyPeriods, next: EffectiveSafetyPeriods): number {
  let hours = 0
  for (const key of SAFETY_PERIOD_SETTINGS) {
    if (!lessSafe(key, next[key], current[key])) continue
    hours = Math.max(hours, current.publishedDelayCriticalHours)
    if (IDENTITY_POLICY_BOUNDS[key].saferWhen === 'longer') hours = Math.max(hours, current[key] * HOURS_PER_UNIT[key])
  }
  return hours
}
