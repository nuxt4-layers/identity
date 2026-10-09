/**
 * Conformance suite for Identity's directory port (improvement register
 * item 1).
 *
 * Any implementation of `IdentityDirectory` (Identity's own, a caching
 * adapter, or a host's stand-in) must pass these checks. They prove that it
 * fails closed, honours each consistency level, revokes within the bound,
 * applies effective status and dates, and answers only with schema-valid
 * data, which carries no personal data.
 *
 * Framework-free: `identityDirectoryConformance` returns named checks that
 * throw on failure, for any test runner:
 *
 * ```ts
 * for (const check of identityDirectoryConformance(subject)) it(check.name, check.run)
 * ```
 *
 * Imports only the contract (and through it, zod).
 */

import type { ActorContext, DirectoryConsistency, IdentityDirectory } from '../contracts'
import { IDENTITY_MAX_STALENESS_SECONDS, actorContextSchema, groupDescriptionSchema } from '../contracts'

/** Identifiers of the scenario the fixture seeds at the source of truth. */
export interface ConformanceScenario {
  /** An active person with an active membership of `groupId`. */
  memberId: string
  /** A standard group in `tenantId` with a parent, `parentGroupId`. */
  groupId: string
  parentGroupId: string
  tenantId: string
  /** A person whose identity is `paused`, with an active membership of `groupId`. */
  pausedIdentityId: string
  /** A person with a membership of `groupId` that starts in the future. */
  futureMemberId: string
  /** A person with a membership of `groupId` whose `endsAt` has passed but is not yet recorded `ended`. */
  lapsedMemberId: string
  /** A person whose identity is `pending`. */
  pendingIdentityId: string
  /** Identifiers that exist nowhere. */
  unknownIdentityId: string
  unknownGroupId: string
}

/** Controls over the source of truth behind the directory under test. */
export interface ConformanceFixture {
  /** Seeds the scenario afresh and returns its identifiers. */
  seed(): Promise<ConformanceScenario>
  /** Ends a membership at the source of truth (as leaving would). */
  endMembership(identityId: string, groupId: string): Promise<void>
  /** Makes the source of truth fail until `restore` (connection lost, timeout). */
  breakSource(): Promise<void>
  restore(): Promise<void>
  /** Advances the clock the directory's caches use, in seconds. */
  advanceSeconds(seconds: number): Promise<void>
}

export interface ConformanceSubject {
  directory: IdentityDirectory
  fixture: ConformanceFixture
  /** The directory's own bound for `bounded` answers; at most `IDENTITY_MAX_STALENESS_SECONDS`. */
  boundedStalenessSeconds: number
}

export interface ConformanceCheck {
  name: string
  run(): Promise<void>
}

function fail(message: string): never {
  throw new Error(`Identity directory conformance: ${message}`)
}

function membershipOf(actor: ActorContext | null, groupId: string) {
  return actor?.memberships.find(membership => membership.group.groupId === groupId)
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return false
  }
  catch {
    return true
  }
}

const CONSISTENCIES: readonly DirectoryConsistency[] = ['strong', 'bounded']

export function identityDirectoryConformance(subject: ConformanceSubject): ConformanceCheck[] {
  const { directory, fixture } = subject
  const read = (identityId: string, consistency: DirectoryConsistency) => directory.resolveActor(identityId, { consistency })

  return [
    {
      name: 'declares a bounded staleness no greater than the contract allows',
      async run() {
        if (!(subject.boundedStalenessSeconds > 0 && subject.boundedStalenessSeconds <= IDENTITY_MAX_STALENESS_SECONDS)) {
          fail(`boundedStalenessSeconds must be in (0, ${IDENTITY_MAX_STALENESS_SECONDS}]`)
        }
      },
    },
    {
      name: 'answers null for unknown and pending identities and unknown groups',
      async run() {
        const scenario = await fixture.seed()
        for (const consistency of CONSISTENCIES) {
          if (await read(scenario.unknownIdentityId, consistency) !== null) fail(`unknown identity is not null (${consistency})`)
          if (await read(scenario.pendingIdentityId, consistency) !== null) fail(`pending identity is not null (${consistency})`)
          if (await directory.describeGroup(scenario.unknownGroupId, { consistency }) !== null) fail(`unknown group is not null (${consistency})`)
        }
      },
    },
    {
      name: 'answers only with schema-valid data (strict objects, no personal data)',
      async run() {
        const scenario = await fixture.seed()
        for (const consistency of CONSISTENCIES) {
          const actor = await read(scenario.memberId, consistency)
          const parsed = actorContextSchema.safeParse(actor)
          if (!parsed.success) fail(`actor context is invalid (${consistency}): ${parsed.error.message}`)
          const group = groupDescriptionSchema.safeParse(await directory.describeGroup(scenario.groupId, { consistency }))
          if (!group.success) fail(`group description is invalid (${consistency}): ${group.error.message}`)
        }
      },
    },
    {
      name: 'describes lineage root first, ending with the group, within one tenant',
      async run() {
        const scenario = await fixture.seed()
        const group = await directory.describeGroup(scenario.groupId, { consistency: 'strong' })
        if (!group) fail('known group is null')
        if (group.lineage.at(-1) !== scenario.groupId || group.lineage.at(-2) !== scenario.parentGroupId) fail('lineage is not root first ending parent, group')
        if (group.tenantId !== scenario.tenantId) fail('tenant differs from the seeded tenant')
        const parent = await directory.describeGroup(scenario.parentGroupId, { consistency: 'strong' })
        if (parent?.tenantId !== group.tenantId) fail('parent and child are in different tenants')
      },
    },
    {
      name: 'rejects, never answers null or stale data, when the source fails on a strong read',
      async run() {
        const scenario = await fixture.seed()
        await read(scenario.memberId, 'bounded')
        await fixture.breakSource()
        try {
          if (!await rejects(read(scenario.memberId, 'strong'))) fail('strong resolveActor did not reject')
          if (!await rejects(directory.describeGroup(scenario.groupId, { consistency: 'strong' }))) fail('strong describeGroup did not reject')
        }
        finally {
          await fixture.restore()
        }
      },
    },
    {
      name: 'rejects a bounded read when the source fails and no answer within the bound is held',
      async run() {
        const scenario = await fixture.seed()
        await fixture.breakSource()
        try {
          if (!await rejects(read(scenario.memberId, 'bounded'))) fail('bounded resolveActor did not reject with nothing cached')
        }
        finally {
          await fixture.restore()
        }
      },
    },
    {
      name: 'reflects an ended membership at once on a strong read, even after a bounded read',
      async run() {
        const scenario = await fixture.seed()
        if (!membershipOf(await read(scenario.memberId, 'bounded'), scenario.groupId)) fail('seeded membership missing')
        await fixture.endMembership(scenario.memberId, scenario.groupId)
        if (membershipOf(await read(scenario.memberId, 'strong'), scenario.groupId)) fail('ended membership still listed on a strong read')
      },
    },
    {
      name: 'reflects an ended membership on a bounded read once the bound has passed',
      async run() {
        const scenario = await fixture.seed()
        await read(scenario.memberId, 'bounded')
        await fixture.endMembership(scenario.memberId, scenario.groupId)
        await fixture.advanceSeconds(subject.boundedStalenessSeconds + 1)
        if (membershipOf(await read(scenario.memberId, 'bounded'), scenario.groupId)) fail('ended membership still listed after the staleness bound')
      },
    },
    {
      name: 'reports every membership of a paused identity as paused',
      async run() {
        const scenario = await fixture.seed()
        const actor = await read(scenario.pausedIdentityId, 'strong')
        if (!actor || actor.memberships.length === 0) fail('paused identity has no memberships listed')
        if (actor.identityState !== 'paused') fail('identity state is not paused')
        if (actor.memberships.some(membership => membership.effectiveStatus !== 'paused')) fail('a membership of a paused identity is not effectively paused')
      },
    },
    {
      name: 'leaves out memberships not yet started and those past their end date',
      async run() {
        const scenario = await fixture.seed()
        if (membershipOf(await read(scenario.futureMemberId, 'strong'), scenario.groupId)) fail('a membership that has not started is listed')
        if (membershipOf(await read(scenario.lapsedMemberId, 'strong'), scenario.groupId)) fail('a membership past its end date is listed')
      },
    },
    {
      name: 'never lists a personal group as a membership',
      async run() {
        const scenario = await fixture.seed()
        const actor = await read(scenario.memberId, 'strong')
        if (!actor?.personalGroup) fail('a person has no personal group')
        if (actor.memberships.some(membership => membership.group.kind === 'personal')) fail('a personal group appears among memberships')
      },
    },
  ]
}
