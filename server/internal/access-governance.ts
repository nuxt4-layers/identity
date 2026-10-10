import type { EffectiveSafetyPeriods, GovernedGroup, IdentityAccessGovernance, IdentityPolicy } from '../../contracts'
import {
  ACCESS_GOVERNANCE_MAX_CONTROLS,
  DEFAULT_GROUP_SETTINGS,
  IdentityError,
  correlationIdSchema,
  governedGroupSchema,
  groupDescriptionSchema,
  groupSettingsSchema,
  identifierSchema,
  instantSchema,
} from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'
import { platformPeriods, safetyPeriodsFor } from './safety-periods'

/**
 * PRIVATE. Identity's access governance (docs/contracts.md §10.4): the facts
 * Authorisation needs to apply Identity's approval rules to its own pending
 * changes (iam-integration `docs/processes/access-administration.md`). Every
 * read comes from the source of truth, through SECURITY DEFINER functions for
 * what spans tenants, and every answer is parsed with the contract's schema
 * before it leaves, so malformed data fails closed. It decides nothing and
 * checks no permission: the host calls it from its adapter, server-side only.
 */

export interface AccessGovernanceDependencies {
  db: Database
  policy: IdentityPolicy
  clock?: Clock
}

interface RawFacts {
  group: unknown
  parentGroupId: string | null
  personalOfIdentityId: string | null
  approvals: unknown
  credentialsRecoveredAt: string | null
  controls: string[]
}

function input<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

function stored<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('unavailable', 'stored governance facts are malformed')
  }
}

export function createAccessGovernance({ db, policy, clock = systemClock }: AccessGovernanceDependencies): IdentityAccessGovernance {
  return {
    async describeGroup(raw) {
      const groupId = input(() => identifierSchema.parse(raw.groupId))
      const identityId = input(() => identifierSchema.parse(raw.identityId))
      const correlationId = input(() => correlationIdSchema.parse(raw.correlationId))
      const { rows } = await db.transaction(client => client.query<{ result: RawFacts | null }>(
        `select ${db.schema}.access_governance_facts($1, $2, $3) as result`,
        [groupId, identityId, ACCESS_GOVERNANCE_MAX_CONTROLS],
      ), { correlationId })
      const facts = rows[0]?.result
      if (!facts) return null
      const group = stored(() => groupDescriptionSchema.parse(facts.group))
      const personal = group.kind === 'personal'
      const approvals = personal ? DEFAULT_GROUP_SETTINGS.approvals : stored(() => groupSettingsSchema.shape.approvals.parse(facts.approvals))
      const periods: EffectiveSafetyPeriods = personal ? await platformPeriods(db, policy) : await safetyPeriodsFor(db, policy, group.groupId)
      const now = clock.now()
      const recovered = facts.credentialsRecoveredAt === null ? null : stored(() => Date.parse(instantSchema.parse(facts.credentialsRecoveredAt)))
      const holdEnds = recovered === null ? null : recovered + periods.recoveryHoldHours * 3_600_000
      const answer: GovernedGroup = {
        groupId: group.groupId,
        tenantId: group.tenantId,
        kind: group.kind,
        state: group.state,
        parentGroupId: facts.parentGroupId,
        rootGroupId: group.lineage[0]!,
        personalOfIdentityId: facts.personalOfIdentityId,
        approvals: { required: { ...approvals.required }, referenceRequired: approvals.referenceRequired },
        safetyPeriods: {
          publishedDelayHighHours: periods.publishedDelayHighHours,
          publishedDelayCriticalHours: periods.publishedDelayCriticalHours,
          approvalExpiryDays: periods.approvalExpiryDays,
          recoveryHoldHours: periods.recoveryHoldHours,
        },
        requester: {
          recoveryHoldUntil: holdEnds !== null && holdEnds > now.getTime() ? new Date(holdEnds).toISOString() : null,
          controls: facts.controls,
        },
      }
      return stored(() => governedGroupSchema.parse(answer))
    },

    async isOwner(raw) {
      const identityId = input(() => identifierSchema.parse(raw.identityId))
      const groupId = input(() => identifierSchema.parse(raw.groupId))
      const { rows } = await db.transaction(client => client.query<{ owner: boolean }>(
        `select ${db.schema}.is_active_owner($1, $2) as owner`,
        [identityId, groupId],
      ))
      return rows[0]?.owner === true
    },

    async countOwners(raw) {
      const groupId = input(() => identifierSchema.parse(raw.groupId))
      const excluding = input(() => identifierSchema.array().max(ACCESS_GOVERNANCE_MAX_CONTROLS).parse(raw.excluding))
      const { rows } = await db.transaction(client => client.query<{ n: number }>(
        `select ${db.schema}.count_active_owners($1, $2::uuid[]) as n`,
        [groupId, excluding],
      ))
      const n = rows[0]?.n
      return stored(() => {
        if (!Number.isInteger(n) || n! < 0) throw new Error('malformed count')
        return n!
      })
    },
  }
}
