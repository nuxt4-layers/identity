import type { ConformanceFixture, ConformanceScenario } from '../../conformance'
import type { ActorContext, DirectoryReadOptions, GroupDescription, IdentityDirectory, IdentityState, MembershipRecord } from '../../contracts'
import { effectiveStatus } from '../../contracts'
import { membership, uuidv7 } from './fixtures'

/**
 * TEST SUPPORT ONLY: an in-memory source of truth and a caching directory
 * over it, used to show the conformance suite can be passed and to show
 * that it catches faulty adapters. Never a fallback store: the layer itself
 * has no in-memory mode.
 */

interface SourceIdentity { identityId: string, state: IdentityState, personalGroupId: string | null }

export class MemorySource {
  identities = new Map<string, SourceIdentity>()
  groups = new Map<string, GroupDescription>()
  memberships: MembershipRecord[] = []
  broken = false
  now = Date.parse('2026-10-09T12:00:00.000Z')

  check(): void {
    if (this.broken) throw new Error('source unavailable')
  }
}

export interface MemoryDirectoryOptions {
  /** Faults to inject, to show the suite catches them. */
  fault?: 'null-on-failure' | 'cache-strong-reads' | 'ignore-identity-state' | 'list-not-started' | 'never-expire-cache'
  stalenessSeconds?: number
}

export function memoryDirectory(source: MemorySource, options: MemoryDirectoryOptions = {}): IdentityDirectory {
  const staleness = options.stalenessSeconds ?? 30
  const cache = new Map<string, { at: number, value: ActorContext | null }>()

  function read(identityId: string): ActorContext | null {
    source.check()
    const identity = source.identities.get(identityId)
    if (!identity || identity.state === 'pending') return null
    const now = new Date(source.now)
    const memberships = source.memberships
      .filter(record => record.identityId === identityId)
      .map(record => ({
        record,
        status: options.fault === 'ignore-identity-state' ? effectiveStatus(record, 'active', now) : effectiveStatus(record, identity.state, now),
      }))
      .filter(({ status }) => status !== 'ended' && (options.fault === 'list-not-started' || status !== 'not-started'))
      .map(({ record, status }) => ({
        membershipId: record.membershipId,
        group: source.groups.get(record.groupId)!,
        kind: record.kind,
        state: record.state as 'active' | 'paused' | 'suspended',
        effectiveStatus: (status === 'not-started' ? 'active' : status) as 'active' | 'paused' | 'suspended',
        owner: record.owner,
        startsAt: record.startsAt,
        endsAt: record.endsAt,
      }))
    return {
      identityId,
      kind: 'person',
      identityState: identity.state as Exclude<IdentityState, 'pending'>,
      personalGroup: identity.personalGroupId ? source.groups.get(identity.personalGroupId)! : null,
      memberships,
      readAt: now.toISOString(),
    }
  }

  return {
    async resolveActor(identityId: string, { consistency }: DirectoryReadOptions) {
      const cached = cache.get(identityId)
      const fresh = cached && (options.fault === 'never-expire-cache' || source.now - cached.at <= staleness * 1000)
      if (fresh && (consistency === 'bounded' || options.fault === 'cache-strong-reads')) return cached.value
      try {
        const value = read(identityId)
        cache.set(identityId, { at: source.now, value })
        return value
      }
      catch (error) {
        if (options.fault === 'null-on-failure') return null
        throw error
      }
    },
    async describeGroup(groupId: string) {
      try {
        source.check()
      }
      catch (error) {
        if (options.fault === 'null-on-failure') return null
        throw error
      }
      return source.groups.get(groupId) ?? null
    },
  }
}

export function memoryFixture(source: MemorySource): ConformanceFixture {
  return {
    async seed(): Promise<ConformanceScenario> {
      source.identities.clear()
      source.groups.clear()
      source.memberships = []
      const tenantId = uuidv7()
      const parentGroupId = uuidv7()
      const groupId = uuidv7()
      source.groups.set(parentGroupId, { groupId: parentGroupId, tenantId, lineage: [parentGroupId], kind: 'standard', state: 'active' })
      source.groups.set(groupId, { groupId, tenantId, lineage: [parentGroupId, groupId], kind: 'standard', state: 'active' })
      const at = (offsetDays: number) => new Date(source.now + offsetDays * 86_400_000).toISOString()
      const addPerson = (state: IdentityState) => {
        const identityId = uuidv7()
        const personalGroupId = uuidv7()
        source.groups.set(personalGroupId, { groupId: personalGroupId, tenantId, lineage: [personalGroupId], kind: 'personal', state: 'active' })
        source.identities.set(identityId, { identityId, state, personalGroupId })
        return identityId
      }
      const memberId = addPerson('active')
      const pausedIdentityId = addPerson('paused')
      const futureMemberId = addPerson('active')
      const lapsedMemberId = addPerson('active')
      const pendingIdentityId = addPerson('pending')
      for (const identityId of [memberId, pausedIdentityId]) {
        source.memberships.push(membership({ identityId, groupId, tenantId, startsAt: at(-10) }))
      }
      source.memberships.push(membership({ identityId: futureMemberId, groupId, tenantId, startsAt: at(5) }))
      source.memberships.push(membership({ identityId: lapsedMemberId, groupId, tenantId, kind: 'guest', startsAt: at(-100), endsAt: at(-1) }))
      return { memberId, groupId, parentGroupId, tenantId, pausedIdentityId, futureMemberId, lapsedMemberId, pendingIdentityId, unknownIdentityId: uuidv7(), unknownGroupId: uuidv7() }
    },
    async endMembership(identityId, groupId) {
      const record = source.memberships.find(candidate => candidate.identityId === identityId && candidate.groupId === groupId)!
      Object.assign(record, { state: 'ended', endedAt: new Date(source.now).toISOString(), endReason: 'left' })
    },
    async breakSource() {
      source.broken = true
    },
    async restore() {
      source.broken = false
    },
    async advanceSeconds(seconds) {
      source.now += seconds * 1000
    },
  }
}
