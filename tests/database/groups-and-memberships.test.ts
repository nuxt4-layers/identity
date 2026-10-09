import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AccessDecision, IdentityAccessDecision, IdentityEvent, IdentitySubject } from '../../contracts'
import { resolveIdentityPolicy } from '../../contracts'
import { provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createDirectory } from '../../server/internal/directory'
import { createDisclosure } from '../../server/internal/disclosure'
import { createGovernance } from '../../server/internal/governance'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

describe.skipIf(!hasDatabase)('groups, memberships and disclosure on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenantA: string
  let tenantB: string
  let root: string
  const clock: Clock = { now: () => new Date() }

  /** Authorisation stand-in: allows exactly the (principal, permission, group) triples listed. */
  const allowed = new Set<string>()
  let decisionOverride: AccessDecision | null = null
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      if (decisionOverride) return decisionOverride
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)

  const subject = (principalId: string): IdentitySubject =>
    ({ principalId, authenticatedAt: new Date().toISOString(), assurance: { level: 'aal2', phishingResistant: true } })
  const governance = (maxHierarchyDepth = 10) => createGovernance({ db, access, policy: resolveIdentityPolicy({ maxHierarchyDepth }), clock })

  async function person(tenantId = tenantA): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function join(identityId: string, groupId: string, tenantId: string, options: { owner?: boolean, kind?: string, endsAt?: Date | null, startsAt?: Date } = {}): Promise<string> {
    const membershipId = uuidv7()
    await seed(test.admin, [[
      `insert into identity.membership values ($1, $2, $3, $4, $5, 'active', $6, false, $7, $8, null, null, null, now(), 1)`,
      [membershipId, identityId, groupId, tenantId, options.kind ?? 'member', options.owner ?? false, options.startsAt ?? new Date(Date.now() - 86_400_000), options.endsAt ?? null],
    ]])
    return membershipId
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
    return published
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    tenantA = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    tenantB = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    // Root groups arrive with the approvals of phase 3; seed one per tenant.
    root = uuidv7()
    await seed(test.admin, [[`insert into identity."group" values ($1, $2, 'standard', null, 'Company', null, 'active', '{}'::jsonb, now(), 1, 'company')`, [root, tenantA]]])
  })

  beforeEach(async () => {
    allowed.clear()
    decisionOverride = null
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('creating and renaming groups', () => {
    it('creates a child group with its creator as founding owner, and announces both', async () => {
      const alice = await person()
      allow(alice, 'identity.groups:create', root)
      await events()
      const { groupId } = await governance().createGroup({ subject: subject(alice), parentGroupId: root, name: '  Sales   UK ', correlationId: CORRELATION_ID })
      const { rows } = await test.admin.query(`select name, tenant_id, parent_group_id, settings is not null as has_settings from identity."group" where group_id = $1`, [groupId])
      expect(rows).toEqual([{ name: 'Sales UK', tenant_id: tenantA, parent_group_id: root, has_settings: true }])
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.created', 'membership.added'])
      expect(published[0]).toMatchObject({ actorId: alice, correlationId: CORRELATION_ID, tenantId: tenantA, data: { groupId, lineage: [root, groupId], foundingOwnerId: alice } })
      expect(published[1]).toMatchObject({ data: { identityId: alice, groupId, kind: 'member', owner: true } })
      const actor = await createDirectory(db, clock).resolveActor(alice, { consistency: 'strong' })
      expect(actor?.memberships).toEqual([expect.objectContaining({ group: expect.objectContaining({ groupId, lineage: [root, groupId] }), owner: true, effectiveStatus: 'active' })])
    })

    it('answers `forbidden` alike for an unknown parent and a refused one, and passes on a step-up requirement', async () => {
      const alice = await person()
      await events()
      const unknown = governance().createGroup({ subject: subject(alice), parentGroupId: uuidv7(), name: 'X', correlationId: CORRELATION_ID })
      const refused = governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'X', correlationId: CORRELATION_ID })
      await expect(unknown).rejects.toMatchObject({ code: 'forbidden' })
      await expect(refused).rejects.toMatchObject({ code: 'forbidden' })
      decisionOverride = { allowed: false, reason: 'insufficient-assurance', requirement: { minimumLevel: 'aal2', phishingResistant: false, maxAuthenticationAgeSeconds: null } }
      await expect(governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'X', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'insufficient-assurance' })
      expect(await events()).toEqual([])
    })

    it('refuses unsafe and confusable sibling names, and a hierarchy deeper than the policy allows', async () => {
      const alice = await person()
      allow(alice, 'identity.groups:create', root)
      await expect(governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Pay​roll', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'validation-failed', message: 'forbidden-character' })
      await governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Acme', correlationId: CORRELATION_ID })
      await expect(governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Асме', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      const { groupId: child } = await governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Deep', correlationId: CORRELATION_ID })
      allow(alice, 'identity.groups:create', child)
      await expect(governance(2).createGroup({ subject: subject(alice), parentGroupId: child, name: 'Deeper', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
    })

    it('refuses a paused or suspended actor', async () => {
      const alice = await person()
      allow(alice, 'identity.groups:create', root)
      await test.admin.query(`update identity.identity set state = 'paused', previous_state = null where identity_id = $1`, [alice])
      await expect(governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Paused', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('renames a group and announces it; confusable sibling names are refused', async () => {
      const alice = await person()
      allow(alice, 'identity.groups:create', root)
      const { groupId } = await governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Finance', correlationId: CORRELATION_ID })
      const { groupId: other } = await governance().createGroup({ subject: subject(alice), parentGroupId: root, name: 'Legal', correlationId: CORRELATION_ID })
      await events()
      await expect(governance().renameGroup({ subject: subject(alice), groupId, name: 'Treasury', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      allow(alice, 'identity.groups:rename', groupId)
      await governance().renameGroup({ subject: subject(alice), groupId, name: 'Treasury', correlationId: CORRELATION_ID })
      expect((await events()).map(event => [event.type, event.aggregate.version])).toEqual([['group.renamed', 2]])
      await expect(governance().renameGroup({ subject: subject(alice), groupId, name: 'LEGAL', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      expect(other).toBeDefined()
    })
  })

  describe('membership changes', () => {
    async function team() {
      const owner = await person()
      allow(owner, 'identity.groups:create', root)
      const { groupId } = await governance().createGroup({ subject: subject(owner), parentGroupId: root, name: `Team ${uuidv7().slice(-6)}`, correlationId: CORRELATION_ID })
      const member = await person()
      const membershipId = await join(member, groupId, tenantA)
      const { rows } = await test.admin.query('select membership_id from identity.membership where identity_id = $1 and group_id = $2', [owner, groupId])
      await events()
      return { owner, groupId, member, membershipId, ownerMembershipId: rows[0].membership_id as string }
    }

    it('lets a member pause and resume their own membership, never someone else\'s', async () => {
      const { owner, member, membershipId } = await team()
      await expect(governance().pauseMembership({ subject: subject(owner), membershipId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await governance().pauseMembership({ subject: subject(member), membershipId, correlationId: CORRELATION_ID })
      const actor = await createDirectory(db, clock).resolveActor(member, { consistency: 'strong' })
      expect(actor?.memberships.map(membership => membership.effectiveStatus)).toEqual(['paused'])
      await governance().resumeMembership({ subject: subject(member), membershipId, correlationId: CORRELATION_ID })
      expect((await events()).map(event => [event.type, event.actorId, event.aggregate.version])).toEqual([
        ['membership.paused', member, 2],
        ['membership.resumed', member, 3],
      ])
    })

    it('refuses pausing or leaving as the last active owner, or leaving a personal group', async () => {
      const { owner, ownerMembershipId } = await team()
      await expect(governance().pauseMembership({ subject: subject(owner), membershipId: ownerMembershipId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict', message: 'last-owner' })
      await expect(governance().leaveGroup({ subject: subject(owner), membershipId: ownerMembershipId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict', message: 'last-owner' })
      const { rows } = await test.admin.query(`select m.membership_id from identity.membership m join identity."group" g on g.group_id = m.group_id where m.identity_id = $1 and g.kind = 'personal'`, [owner])
      await expect(governance().leaveGroup({ subject: subject(owner), membershipId: rows[0].membership_id, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict', message: 'personal-group' })
    })

    it('lets a member leave, ending access at once and announcing it', async () => {
      const { member, membershipId, groupId } = await team()
      await governance().leaveGroup({ subject: subject(member), membershipId, correlationId: CORRELATION_ID })
      expect((await createDirectory(db, clock).resolveActor(member, { consistency: 'strong' }))?.memberships).toEqual([])
      expect((await events()).map(event => [event.type, event.data])).toEqual([
        ['membership.ended', { membershipId, identityId: member, groupId, endReason: 'left', reasonCode: null }],
      ])
      await expect(governance().leaveGroup({ subject: subject(member), membershipId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
    })

    it('lets an authorised administrator suspend or remove a member with a reason code, but never an owner or themselves', async () => {
      const { owner, groupId, member, membershipId, ownerMembershipId } = await team()
      const act = (action: 'remove' | 'suspend', target: string, by = owner) => governance().actOnMember({ subject: subject(by), membershipId: target, action, reasonCode: 'conduct', correlationId: CORRELATION_ID })
      await expect(act('suspend', membershipId)).rejects.toMatchObject({ code: 'forbidden' })
      allow(owner, 'identity.memberships:suspend', groupId)
      allow(owner, 'identity.memberships:remove', groupId)
      await act('suspend', membershipId)
      expect((await createDirectory(db, clock).resolveActor(member, { consistency: 'strong' }))?.memberships.map(m => m.effectiveStatus)).toEqual(['suspended'])
      await act('remove', membershipId)
      expect((await events()).map(event => [event.type, event.data])).toEqual([
        ['membership.suspended', { membershipId, identityId: member, groupId, reasonCode: 'conduct', changeId: null, breakGlassReviewId: null }],
        ['membership.ended', { membershipId, identityId: member, groupId, endReason: 'removed', reasonCode: 'conduct' }],
      ])
      await expect(act('remove', ownerMembershipId)).rejects.toMatchObject({ code: 'conflict' })
      const other = await join(await person(), groupId, tenantA, { owner: true })
      await expect(act('remove', other)).rejects.toMatchObject({ code: 'conflict', message: 'owners change only with approval' })
      await expect(governance().actOnMember({ subject: subject(owner), membershipId: uuidv7(), action: 'remove', reasonCode: 'conduct', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(governance().actOnMember({ subject: subject(owner), membershipId, action: 'remove', reasonCode: 'He was rude', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'validation-failed' })
    })

    it('ends lapsed memberships in maintenance, announcing each once', async () => {
      const { groupId } = await team()
      const guest = await person()
      const membershipId = await join(guest, groupId, tenantA, { kind: 'guest', startsAt: new Date(Date.now() - 10 * 86_400_000), endsAt: new Date(Date.now() - 1000) })
      await events()
      expect((await createDirectory(db, clock).resolveActor(guest, { consistency: 'strong' }))?.memberships).toEqual([])
      expect((await runMaintenance(db, clock)).endedLapsedMemberships).toBeGreaterThanOrEqual(1)
      expect((await runMaintenance(db, clock)).endedLapsedMemberships).toBe(0)
      expect((await events()).filter(event => event.type === 'membership.ended').map(event => event.data)).toContainEqual({ membershipId, identityId: guest, groupId, endReason: 'expired', reasonCode: null })
    })
  })

  describe('isolation of writes', () => {
    it('refuses, under row-level security, a change to another tenant\'s rows or a group in another tenant', async () => {
      const inB = uuidv7()
      await seed(test.admin, [[`insert into identity."group" values ($1, $2, 'standard', null, 'Other', null, 'active', '{}'::jsonb, now(), 1, 'other')`, [inB, tenantB]]])
      const updated = await db.transaction(client => client.query(`update identity."group" set name = 'Taken', name_skeleton = 'taken' where group_id = $1 returning group_id`, [inB]),
        { tenantIds: [tenantA], actorId: uuidv7(), correlationId: CORRELATION_ID })
      expect(updated.rows).toEqual([])
      await expect(db.transaction(client => client.query(`insert into identity."group" values ($1, $2, 'standard', null, 'Sneaky', null, 'active', '{}'::jsonb, now(), 1, 'sneaky')`, [uuidv7(), tenantB]),
        { tenantIds: [tenantA], actorId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('refuses a child group in a different tenant from its parent, even with both tenants in scope', async () => {
      await expect(db.transaction(client => client.query(`insert into identity."group" values ($1, $2, 'standard', $3, 'Bridge', null, 'active', '{}'::jsonb, now(), 1, 'bridge')`, [uuidv7(), tenantB, root]),
        { tenantIds: [tenantA, tenantB], actorId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
    })

    it('limits the runtime role to the writes phase 2b makes: no root groups, no self-made owners, no protected columns', async () => {
      const intruder = await person()
      const context = { tenantIds: [tenantA], actorId: intruder, correlationId: CORRELATION_ID }
      await expect(db.transaction(client => client.query(`insert into identity."group" values ($1, $2, 'standard', null, 'Root', null, 'active', '{}'::jsonb, now(), 1, 'root')`, [uuidv7(), tenantA]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`insert into identity.membership values ($1, $2, $3, $4, 'member', 'active', true, false, now(), null, null, null, null, now(), 1)`, [uuidv7(), intruder, root, tenantA]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`insert into identity.membership values ($1, $2, $3, $4, 'member', 'active', true, true, now(), null, null, null, null, now(), 1)`, [uuidv7(), intruder, root, tenantA]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`update identity.membership set owner = true where identity_id = $1`, [intruder]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`update identity."group" set settings = '{}'::jsonb, state = 'archived' where group_id = $1`, [root]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`select * from identity.outbox`), context)).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('refuses any change without a correlation identifier, so no change goes unannounced', async () => {
      await expect(db.transaction(client => client.query(`update identity."group" set name = 'Silent', name_skeleton = 'silent' where group_id = $1`, [root]),
        { tenantIds: [tenantA] })).rejects.toMatchObject({ code: 'unavailable' })
      const { rows } = await test.admin.query('select name from identity."group" where group_id = $1', [root])
      expect(rows[0].name).toBe('Company')
    })
  })

  describe('disclosure context for Profile', () => {
    it('relates a viewer to subjects without revealing groups the viewer is not in', async () => {
      const viewer = await person()
      allow(viewer, 'identity.groups:create', root)
      const { groupId } = await governance().createGroup({ subject: subject(viewer), parentGroupId: root, name: `Club ${uuidv7().slice(-6)}`, correlationId: CORRELATION_ID })
      const colleague = await person()
      await join(colleague, groupId, tenantA)
      const leaver = await person()
      const leaverMembership = await join(leaver, groupId, tenantA)
      await governance().leaveGroup({ subject: subject(leaver), membershipId: leaverMembership, correlationId: CORRELATION_ID })
      const tenantmate = await person()
      await join(tenantmate, root, tenantA)
      const stranger = await person(tenantB)
      const paused = await person()
      await join(paused, groupId, tenantA)
      await test.admin.query(`update identity.identity set state = 'paused' where identity_id = $1`, [paused])

      const disclosure = createDisclosure(db, clock)
      const inGroup = await disclosure.describe({ viewerId: viewer, subjectIds: [viewer, colleague, leaver, tenantmate, stranger, paused, uuidv7()], groupId }, { consistency: 'bounded' })
      expect(inGroup.groupId).toBe(groupId)
      expect(inGroup.departurePolicy).toMatchObject({ attribution: 'keep-name', historyVisibility: 'administrators' })
      expect(inGroup.subjects.map(s => [s.relationship, s.standing])).toEqual([
        ['self', 'visible'],
        ['same-group', 'visible'],
        ['former-member', 'visible'],
        ['same-tenant', 'visible'],
        ['none', 'visible'],
        ['same-group', 'paused'],
        ['none', 'gone'],
      ])
      expect(inGroup.subjects[2]!.membershipInGroup).toMatchObject({ state: 'ended', endedAt: expect.any(String) })
      expect(inGroup.subjects[3]!.membershipInGroup).toBeNull()

      const noContext = await disclosure.describe({ viewerId: viewer, subjectIds: [colleague, tenantmate, stranger], groupId: null }, { consistency: 'bounded' })
      expect(noContext.subjects.map(s => s.relationship)).toEqual(['same-group', 'same-tenant', 'none'])
      expect(noContext.departurePolicy).toBeNull()

      const outsider = await disclosure.describe({ viewerId: stranger, subjectIds: [colleague], groupId }, { consistency: 'bounded' })
      expect(outsider).toMatchObject({ groupId: null, departurePolicy: null, subjects: [{ relationship: 'none', membershipInGroup: null }] })
    })

    it('refuses malformed and oversized requests', async () => {
      const disclosure = createDisclosure(db, clock)
      await expect(disclosure.describe({ viewerId: 'x', subjectIds: [uuidv7()], groupId: null }, { consistency: 'bounded' })).rejects.toMatchObject({ code: 'validation-failed' })
      await expect(disclosure.describe({ viewerId: uuidv7(), subjectIds: Array.from({ length: 201 }, () => uuidv7()), groupId: null }, { consistency: 'bounded' })).rejects.toMatchObject({ code: 'validation-failed' })
    })
  })
})
