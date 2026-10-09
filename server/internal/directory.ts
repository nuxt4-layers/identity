import type { ActorContext, DirectoryMembership, GroupDescription, IdentityDirectory, IdentityState } from '../../contracts'
import { actorContextSchema, effectiveStatus, groupDescriptionSchema, UUID_PATTERN } from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Identity's own directory (docs/contracts.md §10.2). Every read
 * comes from the source of truth, which satisfies both consistency levels;
 * a host may add a cache in front of it, which must pass the conformance
 * suite. Answers are validated against the contract before they leave, so
 * malformed data fails closed rather than reaching Authorisation.
 */

interface RawMembership extends Omit<DirectoryMembership, 'effectiveStatus'> {}

interface RawActor {
  identityId: string
  kind: ActorContext['kind']
  identityState: IdentityState
  personalGroup: GroupDescription | null
  memberships: RawMembership[]
}

export function createDirectory(db: Database, clock: Clock = systemClock): IdentityDirectory {
  return {
    async resolveActor(identityId) {
      if (typeof identityId !== 'string' || !UUID_PATTERN.test(identityId)) return null
      const { rows } = await db.transaction(client => client.query<{ result: RawActor | null }>(
        `select ${db.schema}.resolve_actor($1) as result`,
        [identityId],
      ))
      const raw = rows[0]?.result
      if (!raw) return null
      const now = clock.now()
      const memberships = raw.memberships.flatMap((membership) => {
        const status = effectiveStatus({ state: membership.state, startsAt: membership.startsAt, endsAt: membership.endsAt }, raw.identityState, now)
        return status === 'ended' || status === 'not-started' ? [] : [{ ...membership, effectiveStatus: status }]
      })
      return actorContextSchema.parse({ ...raw, memberships, readAt: now.toISOString() })
    },

    async describeGroup(groupId) {
      if (typeof groupId !== 'string' || !UUID_PATTERN.test(groupId)) return null
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.describe_group($1) as result`,
        [groupId],
      ))
      const raw = rows[0]?.result
      return raw ? groupDescriptionSchema.parse(raw) : null
    },
  }
}
