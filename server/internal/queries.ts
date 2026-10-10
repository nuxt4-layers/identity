import type {
  GroupMembersPage,
  GroupView,
  IdentityAccessDecision,
  IdentityExport,
  IdentityPolicy,
  IdentityPermissionName,
  IdentitySubject,
  MembershipRecord,
  PendingChange,
  SelfView,
} from '../../contracts'
import {
  correlationIdSchema,
  effectiveSafetyPeriods,
  effectiveStatus,
  groupDescriptionSchema,
  groupMembersPageSchema,
  groupViewSchema,
  IdentityError,
  identifierSchema,
  identityExportSchema,
  identitySubjectSchema,
  pendingChangeSchema,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  scimActive,
  scimGroupStructureSchema,
  scimUserStructureSchema,
  scimVersion,
  selfViewSchema,
} from '../../contracts'
import type { Database } from './database'
import { createDirectory } from './directory'
import { safetyLevels } from './safety-periods'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Read functions for the administration surface (docs/contracts.md
 * §19). Each authorises the caller through the access-decision port before
 * reading (an unknown group and a refused caller are both `forbidden`), and
 * parses every answer with the contract before it leaves the layer.
 */

export interface QueriesDependencies {
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

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString())

export function createQueries({ db, access, policy, clock = systemClock }: QueriesDependencies) {
  async function authorisedGroup(subject: IdentitySubject, groupId: string, permission: IdentityPermissionName, correlationId: string) {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.describe_group($1) as result`, [groupId]))
    const group = rows[0]?.result ? groupDescriptionSchema.parse(rows[0].result) : null
    if (!group || group.kind !== 'standard') throw new IdentityError('forbidden')
    let decision
    try {
      decision = await access.decide({ subject, permission, groupId, correlationId })
    }
    catch {
      throw new IdentityError('unavailable', 'access decision failed')
    }
    if (!decision.allowed) throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
    return group
  }

  function prepare(input: { subject: IdentitySubject, groupId: string, correlationId: string }) {
    return {
      subject: parse(() => identitySubjectSchema.parse(input.subject)),
      groupId: parse(() => identifierSchema.parse(input.groupId)),
      correlationId: parse(() => correlationIdSchema.parse(input.correlationId)),
    }
  }

  return {
    /** The signed-in identity's own actor context, and the groups it alone owns. Null when it is unknown or pending. */
    async self(input: { subject: IdentitySubject }): Promise<SelfView | null> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const actor = await createDirectory(db, clock).resolveActor(subject.principalId, { consistency: 'strong' })
      if (!actor) return null
      const { rows } = await db.transaction(client => client.query<{ groups: string[] }>(
        `select ${db.schema}.last_owner_of($1)::text[] as groups`,
        [subject.principalId],
      ), { at: clock.now() })
      const tenantIds = [...new Set(actor.memberships.map(membership => membership.group.tenantId))]
      const groupIds = actor.memberships.map(membership => membership.group.groupId)
      const names = groupIds.length === 0
        ? []
        : (await db.transaction(client => client.query<{ groupId: string, name: string }>(
            `select group_id::text as "groupId", name from ${db.schema}."group" where group_id = any ($1::uuid[]) and kind = 'standard' order by name, group_id`,
            [groupIds],
          ), { tenantIds })).rows
      const former = await db.transaction(client => client.query<{ groups: unknown }>(
        `select ${db.schema}.former_group_names($1) as groups`,
        [subject.principalId],
      ), { at: clock.now() })
      return selfViewSchema.parse({ actor, groupNames: names, formerGroupNames: former.rows[0]?.groups ?? [], lastOwnerOf: rows[0]?.groups ?? [] })
    },

    /** A group, its settings, lineage and safety periods (`identity.groups:view`). */
    async group(input: { subject: IdentitySubject, groupId: string, correlationId: string }): Promise<GroupView> {
      const { subject, groupId, correlationId } = prepare(input)
      const group = await authorisedGroup(subject, groupId, 'identity.groups:view', correlationId)
      const { rows } = await db.transaction(client => client.query<Record<string, unknown>>(
        `select group_id, tenant_id, kind, parent_group_id, name, external_id, state, settings, created_at, version from ${db.schema}."group" where group_id = $1`,
        [groupId],
      ), { tenantIds: [group.tenantId] })
      const row = rows[0]
      if (!row) throw new IdentityError('forbidden')
      const levels = await safetyLevels(db, policy, groupId)
      return groupViewSchema.parse({
        group: {
          groupId: row.group_id,
          tenantId: row.tenant_id,
          kind: row.kind,
          parentGroupId: row.parent_group_id,
          name: row.name,
          externalId: row.external_id,
          state: row.state,
          settings: row.settings,
          createdAt: iso(row.created_at as Date),
          version: row.version,
        },
        lineage: group.lineage,
        safetyPeriods: { own: levels.group, effective: effectiveSafetyPeriods(policy, levels), isPlatformGroup: levels.isPlatformGroup },
      })
    },

    /** A page of a group's live memberships with their effective status (`identity.memberships:view`). */
    async members(input: { subject: IdentitySubject, groupId: string, after?: string | null, correlationId: string }): Promise<GroupMembersPage> {
      const { subject, groupId, correlationId } = prepare(input)
      const after = input.after == null ? null : parse(() => identifierSchema.parse(input.after))
      await authorisedGroup(subject, groupId, 'identity.memberships:view', correlationId)
      const now = clock.now()
      const limit = 100
      const { rows } = await db.transaction(client => client.query<{ result: { membership: MembershipRecord, identityState: string }[] }>(
        `select ${db.schema}.group_members($1, $2, $3) as result`,
        [groupId, after, limit + 1],
      ))
      const page = rows[0]?.result ?? []
      const members = page.slice(0, limit).map(({ membership, identityState }) => ({
        membership,
        effectiveStatus: effectiveStatus(membership, identityState as never, now),
      }))
      return groupMembersPageSchema.parse({
        groupId,
        members,
        nextCursor: page.length > limit ? members.at(-1)!.membership.membershipId : null,
        readAt: now.toISOString(),
      })
    },

    /** A group's pending changes, newest first (`identity.groups:view`). */
    async changes(input: { subject: IdentitySubject, groupId: string, correlationId: string }): Promise<PendingChange[]> {
      const { subject, groupId, correlationId } = prepare(input)
      const group = await authorisedGroup(subject, groupId, 'identity.groups:view', correlationId)
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.change_json(c) as result from ${db.schema}.pending_change c
         where c.group_id = $1 and c.state in ('awaiting-approval', 'delayed') order by c.created_at desc, c.change_id limit 200`,
        [groupId],
      ), { tenantIds: [group.tenantId] })
      return rows.map(row => pendingChangeSchema.parse(row.result))
    },
  }
}

/**
 * Identity's part of a data-subject access request. Server-only: the host
 * calls it from iam-integration's data-subject request process once the
 * request is verified. Null when the identity is unknown.
 */
export async function exportIdentity(db: Database, input: { identityId: string, correlationId: string }, clock: Clock = systemClock): Promise<IdentityExport | null> {
  const identityId = parse(() => identifierSchema.parse(input.identityId))
  const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
  const { rows } = await db.transaction(client => client.query<{ result: Record<string, unknown> | null }>(`select ${db.schema}.export_identity($1) as result`, [identityId]))
  const found = rows[0]?.result
  if (!found) return null
  return identityExportSchema.parse({ ...found, exportedAt: clock.now().toISOString(), correlationId })
}

/**
 * The structural part of SCIM 2.0 resources (improvement register item 5),
 * for the SCIM endpoint the host composes with Authentication's `userName`
 * and Profile's attributes. Server-only. Null when unknown.
 */
export function createScimStructure(db: Database, clock: Clock = systemClock) {
  return {
    async user(input: { identityId: string, tenantId: string }) {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const tenantId = parse(() => identifierSchema.parse(input.tenantId))
      const { rows } = await db.transaction(client => client.query<{ result: { identityId: string, state: string, createdAt: string, lastModified: string, version: number, externalId: string | null } | null }>(
        `select ${db.schema}.scim_user($1, $2) as result`,
        [identityId, tenantId],
      ))
      const found = rows[0]?.result
      if (!found) return null
      return scimUserStructureSchema.parse({
        schemas: [SCIM_USER_SCHEMA],
        id: found.identityId,
        ...(found.externalId ? { externalId: found.externalId } : {}),
        active: scimActive(found.state as never),
        meta: { resourceType: 'User', created: found.createdAt, lastModified: found.lastModified, version: scimVersion(found.version) },
      })
    },

    async group(input: { groupId: string }) {
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const { rows } = await db.transaction(client => client.query<{ result: { groupId: string, externalId: string | null, name: string, createdAt: string, version: number, members: string[] } | null }>(
        `select ${db.schema}.scim_group($1, $2) as result`,
        [groupId, clock.now()],
      ))
      const found = rows[0]?.result
      if (!found) return null
      return scimGroupStructureSchema.parse({
        schemas: [SCIM_GROUP_SCHEMA],
        id: found.groupId,
        ...(found.externalId ? { externalId: found.externalId } : {}),
        displayName: found.name,
        members: found.members.map(value => ({ value, type: 'User' })),
        meta: { resourceType: 'Group', created: found.createdAt, lastModified: found.createdAt, version: scimVersion(found.version) },
      })
    },
  }
}

export type Queries = ReturnType<typeof createQueries>
