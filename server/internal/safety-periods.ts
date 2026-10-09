import type { EffectiveSafetyPeriods, IdentityPolicy, IdentityPolicyPeriods, SafetyPeriodLevels } from '../../contracts'
import { IdentityError, SAFETY_PERIOD_SETTINGS, effectiveSafetyPeriods, platformSafetyPeriods, safetyPeriodsSchema } from '../../contracts'
import type { Database, QueryClient } from './database'

/**
 * PRIVATE. Reads the safety periods in force (docs/contracts.md §21). The
 * database holds each group's own; the host's policy gives the starting
 * values and names the platform group. The database checks the same
 * periods again whenever it records a change.
 */

/** The host's values for the safety periods, as the database receives them. */
export function hostSafetyPeriods(policy: IdentityPolicy): Record<string, number> {
  return Object.fromEntries(SAFETY_PERIOD_SETTINGS.map(key => [key, policy[key]]))
}

/**
 * Tells the database, for this transaction, which group is the platform's
 * and what the host's values are, so that it checks every change recorded
 * against the periods in force.
 */
export async function setSafetyContext(client: QueryClient, policy: IdentityPolicy): Promise<void> {
  await client.query(
    `select set_config('identity.platform_group_id', $1, true), set_config('identity.host_periods', $2, true)`,
    [policy.platformGroupId ?? '', JSON.stringify(hostSafetyPeriods(policy))],
  )
}

/** The levels that set a standard group's periods. `forbidden` for anything else. */
export async function safetyLevels(db: Database, policy: IdentityPolicy, groupId: string): Promise<SafetyPeriodLevels> {
  const { rows } = await db.transaction(client => client.query<{ result: { own: unknown, root: unknown, platform: unknown, isPlatformGroup: boolean } | null }>(
    `select ${db.schema}.safety_periods_of($1, $2) as result`,
    [groupId, policy.platformGroupId],
  ))
  const found = rows[0]?.result
  if (!found) throw new IdentityError('forbidden')
  try {
    return {
      group: safetyPeriodsSchema.parse(found.own),
      root: found.root == null ? null : safetyPeriodsSchema.parse(found.root),
      platform: found.platform == null ? null : safetyPeriodsSchema.parse(found.platform),
      isPlatformGroup: found.isPlatformGroup === true,
    }
  }
  catch {
    throw new IdentityError('unavailable', 'stored safety periods are malformed')
  }
}

/** The periods in force for a standard group. */
export async function safetyPeriodsFor(db: Database, policy: IdentityPolicy, groupId: string): Promise<EffectiveSafetyPeriods> {
  return effectiveSafetyPeriods(policy as IdentityPolicyPeriods, await safetyLevels(db, policy, groupId))
}

/** The platform's values, for what belongs to no group (the closure grace period). */
export async function platformPeriods(db: Database, policy: IdentityPolicy): Promise<EffectiveSafetyPeriods> {
  if (!policy.platformGroupId) return platformSafetyPeriods(policy, null)
  const { rows } = await db.transaction(client => client.query<{ result: { own: unknown } | null }>(
    `select ${db.schema}.safety_periods_of($1, $1) as result`,
    [policy.platformGroupId],
  ))
  const own = rows[0]?.result?.own
  const parsed = own === undefined ? null : safetyPeriodsSchema.safeParse(own)
  if (parsed && !parsed.success) throw new IdentityError('unavailable', 'stored safety periods are malformed')
  return platformSafetyPeriods(policy, parsed?.data ?? null)
}
