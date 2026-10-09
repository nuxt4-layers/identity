import type { IdentityPolicy, IdentitySubject } from '../../contracts'
import { correlationIdSchema, IdentityError, identifierSchema, identitySubjectSchema, REAUTHENTICATION_MAX_AGE_SECONDS } from '../../contracts'
import type { Database } from './database'
import { platformPeriods } from './safety-periods'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. The identity lifecycle (docs/contracts.md §3.1; iam-integration
 * pausing and suspension, account closure). Every action here is reserved
 * to the person and needs no permission; pausing, requesting closure and
 * cancelling it need a recent authentication. Nobody can do them for
 * another person.
 */

export interface LifecycleDependencies {
  db: Database
  policy: IdentityPolicy
  clock?: Clock
}

const DAY = 86_400_000

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

export function createLifecycle({ db, policy, clock = systemClock }: LifecycleDependencies) {
  function prepare(input: { subject: IdentitySubject, correlationId: string }, reauthenticate: boolean) {
    const subject = parse(() => identitySubjectSchema.parse(input.subject))
    const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
    const now = clock.now()
    if (reauthenticate) {
      const age = (now.getTime() - Date.parse(subject.authenticatedAt)) / 1000
      if (!(age >= 0 && age <= REAUTHENTICATION_MAX_AGE_SECONDS)) throw new IdentityError('insufficient-assurance')
    }
    return { subject, correlationId, now }
  }

  async function lastOwnerOf(identityId: string, now: Date): Promise<string[]> {
    const { rows } = await db.transaction(client => client.query<{ groups: string[] }>(
      `select ${db.schema}.last_owner_of($1)::text[] as groups`,
      [identityId],
    ), { at: now })
    return rows[0]?.groups ?? []
  }

  async function transition(fn: string, identityId: string, args: readonly unknown[], correlationId: string, now: Date): Promise<{ state: string }> {
    const placeholders = args.map((_, index) => `$${index + 2}`).join(', ')
    const { rows } = await db.transaction(
      client => client.query<{ result: { state: string } }>(`select ${db.schema}.${fn}($1${placeholders ? `, ${placeholders}` : ''}) as result`, [identityId, ...args]),
      { actorId: identityId, correlationId, at: now },
    )
    return rows[0]!.result
  }

  return {
    /**
     * Groups of which the person is the last active owner. Pausing leaves
     * them governable only through recovery until the person resumes;
     * closure is refused while there are any, unless the person chooses to
     * leave them to recovery.
     */
    async lastOwnerOf(input: { subject: IdentitySubject }): Promise<string[]> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      return lastOwnerOf(subject.principalId, clock.now())
    },

    /** Pauses the whole identity (after reauthentication). No group can prevent it. Returns the groups it orphans. */
    async pauseIdentity(input: { subject: IdentitySubject, correlationId: string }): Promise<{ state: 'paused', orphanedGroupIds: string[] }> {
      const { subject, correlationId, now } = prepare(input, true)
      const orphanedGroupIds = await lastOwnerOf(subject.principalId, now)
      await transition('pause_identity', subject.principalId, [correlationId, now], correlationId, now)
      return { state: 'paused', orphanedGroupIds }
    },

    /** Resumes a paused identity. */
    async resumeIdentity(input: { subject: IdentitySubject, correlationId: string }): Promise<{ state: 'active' }> {
      const { subject, correlationId, now } = prepare(input, false)
      await transition('resume_identity', subject.principalId, [correlationId, now], correlationId, now)
      return { state: 'active' }
    },

    /**
     * Requests closure (after reauthentication). The identity closes after
     * the platform's `closureGraceDays` (§21), which no group sets. Refused (`conflict`, `last-owner`)
     * while the person is the last active owner of a group, unless
     * `leaveGroupsOrphaned` is true.
     */
    async requestClosure(input: { subject: IdentitySubject, leaveGroupsOrphaned?: boolean, correlationId: string }): Promise<{ state: 'closure-pending', closesAt: string }> {
      const { subject, correlationId, now } = prepare(input, true)
      const { closureGraceDays } = await platformPeriods(db, policy)
      const closesAt = new Date(now.getTime() + closureGraceDays * DAY)
      try {
        await transition('request_closure', subject.principalId, [closesAt, input.leaveGroupsOrphaned === true, correlationId, now], correlationId, now)
      }
      catch (error) {
        if (error instanceof IdentityError && error.message === 'identity:last-owner') throw new IdentityError('conflict', 'last-owner')
        throw error
      }
      return { state: 'closure-pending', closesAt: closesAt.toISOString() }
    },

    /** Cancels a requested closure during the grace period (after reauthentication), restoring the previous state. */
    async cancelClosure(input: { subject: IdentitySubject, correlationId: string }): Promise<{ state: string }> {
      const { subject, correlationId, now } = prepare(input, true)
      return { state: (await transition('cancel_closure', subject.principalId, [correlationId, now], correlationId, now)).state }
    },
  }
}

/**
 * Records a credential recovery that Authentication reported
 * (`authentication.credentials-recovered`, relayed by the host). For
 * `recoveryHoldHours` afterwards, `critical` governance changes the person
 * requests are held. Returns whether the identity is known.
 */
export async function recordCredentialRecovery(db: Database, input: { identityId: string, recoveredAt: string, correlationId: string }): Promise<{ recorded: boolean }> {
  const identityId = parse(() => identifierSchema.parse(input.identityId))
  parse(() => correlationIdSchema.parse(input.correlationId))
  const recoveredAt = new Date(input.recoveredAt)
  if (Number.isNaN(recoveredAt.getTime())) throw new IdentityError('validation-failed')
  const { rows } = await db.transaction(client => client.query<{ recorded: boolean }>(
    `select ${db.schema}.record_credential_recovery($1, $2) as recorded`,
    [identityId, recoveredAt],
  ))
  return { recorded: rows[0]?.recorded === true }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
