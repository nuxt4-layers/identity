import type { IdentityAccessDecision, IdentityPermissionName, IdentityPolicy, IdentitySubject } from '../../contracts'
import {
  checkSafeName,
  confusableSkeleton,
  correlationIdSchema,
  DEFAULT_GROUP_SETTINGS,
  groupDescriptionSchema,
  IdentityError,
  identifierSchema,
  identitySubjectSchema,
  reasonCodeSchema,
  refusedByGovernance,
} from '../../contracts'
import type { Database, QueryClient } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Group and membership changes that need no second approver
 * (phase 2b). Changes that do (owners, reparenting, archiving, root groups,
 * reinstatement) arrive with the approvals engine in phase 3.
 *
 * Order of checks, so that errors stay coarse (docs/contracts.md §12):
 * validate input; locate the target (unknown → `forbidden`); authorise
 * (refused → `forbidden`, or `insufficient-assurance`); only then apply
 * governance rules (`conflict`), which the caller is now entitled to learn.
 */

interface Located {
  membershipId: string
  identityId: string
  groupId: string
  tenantId: string
  groupKind: 'personal' | 'standard'
  groupState: 'active' | 'orphaned' | 'archived'
  state: 'active' | 'paused' | 'suspended' | 'ended'
  kind: 'member' | 'guest'
  owner: boolean
  otherActiveOwners: number
}

export interface GovernanceDependencies {
  db: Database
  access: IdentityAccessDecision
  policy: IdentityPolicy
  clock?: Clock
}

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

async function actorState(client: QueryClient, schema: string, identityId: string): Promise<string | null> {
  const { rows } = await client.query<{ result: { state: string } | null }>(`select ${schema}.sign_in_status($1) as result`, [identityId])
  return rows[0]?.result?.state ?? null
}

export function createGovernance({ db, access, policy, clock = systemClock }: GovernanceDependencies) {
  async function authorise(subject: IdentitySubject, permission: IdentityPermissionName, groupId: string, correlationId: string): Promise<void> {
    let decision
    try {
      decision = await access.decide({ subject, permission, groupId, correlationId })
    }
    catch {
      throw new IdentityError('unavailable', 'access decision failed')
    }
    if (decision.allowed) return
    throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
  }

  /** The subject must be an active identity to change anything but their own pause. */
  async function requireActive(subject: IdentitySubject, allowPaused = false): Promise<void> {
    const state = await db.transaction(client => actorState(client, db.schema, subject.principalId))
    if (state === 'active' || (allowPaused && state === 'paused')) return
    throw new IdentityError('forbidden')
  }

  async function locate(membershipId: string): Promise<Located> {
    const { rows } = await db.transaction(client => client.query<{ result: Located | null }>(
      `select ${db.schema}.locate_membership($1) as result`,
      [membershipId],
    ))
    const found = rows[0]?.result
    if (!found) throw new IdentityError('forbidden')
    return found
  }

  async function update(located: Located, subject: IdentitySubject, correlationId: string, set: string, values: readonly unknown[]): Promise<void> {
    const now = clock.now()
    await db.transaction(async (client) => {
      const { rows } = await client.query(
        `update ${db.schema}.membership set ${set} where membership_id = $1 and state <> 'ended' returning membership_id`,
        [located.membershipId, ...values],
      )
      if (rows.length !== 1) throw new IdentityError('conflict', 'membership changed concurrently')
    }, { tenantIds: [located.tenantId], actorId: subject.principalId, correlationId, at: now })
  }

  return {
    /** Creates a child group, with the creator as its founding owner (`identity.groups:create`, medium). */
    async createGroup(input: { subject: IdentitySubject, parentGroupId: string, name: string, correlationId: string }): Promise<{ groupId: string }> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const parentGroupId = parse(() => identifierSchema.parse(input.parentGroupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const name = checkSafeName(input.name)
      if (!name.ok) throw new IdentityError('validation-failed', name.problem)

      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.describe_group($1) as result`, [parentGroupId]))
      const parent = rows[0]?.result ? groupDescriptionSchema.parse(rows[0].result) : null
      if (!parent || parent.kind !== 'standard') throw new IdentityError('forbidden')
      await authorise(subject, 'identity.groups:create', parent.groupId, correlationId)
      await requireActive(subject)
      if (parent.state !== 'active') throw new IdentityError('conflict', 'parent group is not active')
      if (parent.lineage.length + 1 > policy.maxHierarchyDepth) throw new IdentityError('conflict', 'hierarchy too deep')

      const now = clock.now()
      return db.transaction(async (client) => {
        const tenant = await client.query<{ state: string }>(`select state from ${db.schema}.tenant where tenant_id = $1`, [parent.tenantId])
        if (tenant.rows[0]?.state !== 'active') throw new IdentityError('conflict', 'tenant is not active')
        const { rows: created } = await client.query<{ group_id: string }>(
          `insert into ${db.schema}."group" (group_id, tenant_id, kind, parent_group_id, name, name_skeleton, external_id, state, settings, created_at, version)
           values (${db.schema}.uuid_v7(), $1, 'standard', $2, $3, $4, null, 'active', $5, $6, 1) returning group_id`,
          [parent.tenantId, parent.groupId, name.value, confusableSkeleton(name.value), JSON.stringify(DEFAULT_GROUP_SETTINGS), now],
        )
        const groupId = created[0]!.group_id
        await client.query(
          `insert into ${db.schema}.membership values (${db.schema}.uuid_v7(), $1, $2, $3, 'member', 'active', true, true, $4, null, null, null, null, $4, 1)`,
          [subject.principalId, groupId, parent.tenantId, now],
        )
        return { groupId }
      }, { tenantIds: [parent.tenantId], actorId: subject.principalId, correlationId, at: now })
    },

    /** Renames a group (`identity.groups:rename`, medium). Confusable sibling names are refused. */
    async renameGroup(input: { subject: IdentitySubject, groupId: string, name: string, correlationId: string }): Promise<void> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const name = checkSafeName(input.name)
      if (!name.ok) throw new IdentityError('validation-failed', name.problem)
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.describe_group($1) as result`, [groupId]))
      const group = rows[0]?.result ? groupDescriptionSchema.parse(rows[0].result) : null
      if (!group || group.kind !== 'standard') throw new IdentityError('forbidden')
      await authorise(subject, 'identity.groups:rename', groupId, correlationId)
      await requireActive(subject)
      if (group.state === 'archived') throw new IdentityError('conflict', 'group is archived')
      await db.transaction(async (client) => {
        await client.query(`update ${db.schema}."group" set name = $2, name_skeleton = $3 where group_id = $1`, [groupId, name.value, confusableSkeleton(name.value)])
      }, { tenantIds: [group.tenantId], actorId: subject.principalId, correlationId, at: clock.now() })
    },

    /** The member pauses their own membership. Never a personal group's; never the last active owner's. */
    async pauseMembership(input: { subject: IdentitySubject, membershipId: string, correlationId: string }): Promise<void> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const located = await locate(parse(() => identifierSchema.parse(input.membershipId)))
      if (located.identityId !== subject.principalId) throw new IdentityError('forbidden')
      await requireActive(subject)
      const refusal = refusedByGovernance({ action: 'pause', groupKind: located.groupKind, isOwner: located.owner, otherActiveOwners: located.otherActiveOwners })
      if (refusal) throw new IdentityError('conflict', refusal)
      if (located.state !== 'active') throw new IdentityError('conflict', 'membership is not active')
      await update(located, subject, correlationId, `state = 'paused'`, [])
    },

    /** The member resumes their own paused membership. */
    async resumeMembership(input: { subject: IdentitySubject, membershipId: string, correlationId: string }): Promise<void> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const located = await locate(parse(() => identifierSchema.parse(input.membershipId)))
      if (located.identityId !== subject.principalId) throw new IdentityError('forbidden')
      await requireActive(subject, true)
      if (located.state !== 'paused') throw new IdentityError('conflict', 'membership is not paused')
      await update(located, subject, correlationId, `state = 'active'`, [])
    },

    /** The member leaves. Never a personal group; never as the last active owner. */
    async leaveGroup(input: { subject: IdentitySubject, membershipId: string, correlationId: string }): Promise<void> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const located = await locate(parse(() => identifierSchema.parse(input.membershipId)))
      if (located.identityId !== subject.principalId) throw new IdentityError('forbidden')
      const refusal = refusedByGovernance({ action: 'leave', groupKind: located.groupKind, isOwner: located.owner, otherActiveOwners: located.otherActiveOwners })
      if (refusal) throw new IdentityError('conflict', refusal)
      if (located.state === 'ended') throw new IdentityError('conflict', 'membership has ended')
      await update(located, subject, correlationId, `state = 'ended', ended_at = $2, end_reason = 'left', reason_code = null`, [clock.now()])
    },

    /**
     * An administrator removes (`identity.memberships:remove`) or suspends
     * (`identity.memberships:suspend`) a member who is not an owner, with a
     * reason code. Owners need the approvals of phase 3. Acting on oneself is
     * refused: leaving and pausing are the person's own actions.
     */
    async actOnMember(input: { subject: IdentitySubject, membershipId: string, action: 'remove' | 'suspend', reasonCode: string, correlationId: string }): Promise<void> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const reasonCode = parse(() => reasonCodeSchema.parse(input.reasonCode))
      if (input.action !== 'remove' && input.action !== 'suspend') throw new IdentityError('validation-failed')
      const located = await locate(parse(() => identifierSchema.parse(input.membershipId)))
      if (located.groupKind !== 'standard') throw new IdentityError('forbidden')
      await authorise(subject, input.action === 'remove' ? 'identity.memberships:remove' : 'identity.memberships:suspend', located.groupId, correlationId)
      await requireActive(subject)
      if (located.identityId === subject.principalId) throw new IdentityError('conflict', 'act on yourself by leaving or pausing')
      if (located.owner) throw new IdentityError('conflict', 'owners change only with approval')
      if (located.state === 'ended') throw new IdentityError('conflict', 'membership has ended')
      if (input.action === 'suspend') {
        if (located.state === 'suspended') throw new IdentityError('conflict', 'membership is already suspended')
        await update(located, subject, correlationId, `state = 'suspended', reason_code = $2`, [reasonCode])
      }
      else {
        await update(located, subject, correlationId, `state = 'ended', ended_at = $2, end_reason = 'removed', reason_code = $3`, [clock.now(), reasonCode])
      }
    },
  }
}

export type Governance = ReturnType<typeof createGovernance>
