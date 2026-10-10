import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentityEvent, IdentityPolicyInput, IdentitySubject, PendingChange } from '../../contracts'
import { identityPermissionRisk, resolveIdentityPolicy } from '../../contracts'
import { createApprovals } from '../../server/internal/approvals'
import { bootstrapRootGroup, provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createDirectory } from '../../server/internal/directory'
import { createTenantExport, legalHoldCovers, readDisposal, recordDisposal } from '../../server/internal/end-of-life'
import { createGovernance } from '../../server/internal/governance'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * End of life (docs/contracts.md §22): iam-integration's group deletion,
 * legal holds on groups and tenants, disposal confirmations, the tenant
 * lifecycle and retention, against a real PostgreSQL.
 */
describe.skipIf(!hasDatabase)('end of life on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let platformTenant: string
  let platform: string
  let platformOwner: string
  let platformApprover: string
  let homeTenant: string
  let offset = 0
  const clock: Clock = { now: () => new Date(Date.now() + offset) }

  const allowed = new Set<string>()
  const qualifying = new Set<string>()
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const approvalPolicy: IdentityApprovalPolicy = {
    async riskOf(permission) {
      return identityPermissionRisk(permission)
    },
    async qualifies({ approverId, permission, groupId }) {
      return qualifying.has(`${approverId}|${permission}|${groupId}`)
    },
    async countQualifying({ permission, groupId, excludingId, limit }) {
      return Math.min([...qualifying].filter(entry => entry.endsWith(`|${permission}|${groupId}`) && !entry.startsWith(`${excludingId}|`)).length, limit)
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)
  const qualify = (principalId: string, permission: string, groupId: string) => qualifying.add(`${principalId}|${permission}|${groupId}`)

  const subject = (principalId: string): IdentitySubject => ({
    principalId,
    authenticatedAt: new Date(clock.now().getTime() - 60_000).toISOString(),
    assurance: { level: 'aal2', phishingResistant: true },
  })
  const policyInput = (extra: IdentityPolicyInput = {}): IdentityPolicyInput => ({
    platformGroupId: platform,
    defaultHomeTenantId: homeTenant,
    jurisdictions: ['uk-gdpr'],
    dataRegions: ['uk', 'eu'],
    disposalParticipants: ['authorisation', 'profile'],
    ...extra,
  })
  const approvals = () => createApprovals({ db, access, approvalPolicy, policy: resolveIdentityPolicy(policyInput()), clock })
  const governance = () => createGovernance({ db, access, policy: resolveIdentityPolicy(policyInput()), clock })
  const maintain = () => runMaintenance(db, clock, 500, resolveIdentityPolicy(policyInput()))
  const justification = { reasonCode: 'legal-order', reference: null }

  async function person(tenantId: string): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId, dataRegions: ['uk', 'eu'] }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function tenant(dataRegion = 'uk'): Promise<{ tenantId: string, root: string, owner: string }> {
    const { tenantId } = await provisionTenant(operator, resolveIdentityPolicy({ dataRegions: ['uk', 'eu'] }), { jurisdiction: 'uk-gdpr', dataRegion, correlationId: CORRELATION_ID }, clock)
    const owner = await person(tenantId)
    const { groupId } = await bootstrapRootGroup(operator, { tenantId, name: `Root ${uuidv7().slice(-6)}`, firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)
    return { tenantId, root: groupId, owner }
  }

  async function childGroup(parent: string, owner: string): Promise<string> {
    allow(owner, 'identity.groups:create', parent)
    const { groupId } = await governance().createGroup({ subject: subject(owner), parentGroupId: parent, name: `Team ${uuidv7().slice(-8)}`, correlationId: CORRELATION_ID })
    return groupId
  }

  async function join(identityId: string, groupId: string): Promise<string> {
    const membershipId = uuidv7()
    await seed(test.admin, [[
      `insert into identity.membership values ($1, $2, $3, (select tenant_id from identity."group" where group_id = $3), 'member', 'active', false, false, now() - interval '1 day', null, null, null, null, now(), 1)`,
      [membershipId, identityId, groupId],
    ]])
    return membershipId
  }

  /** Archives a group as if it had been archived `ago` milliseconds before the clock's now. */
  async function archive(groupId: string, ago: number): Promise<void> {
    // Archiving stamps the time itself; the second statement backdates it.
    await seed(test.admin, [
      [`update identity."group" set state = 'archived' where group_id = $1`, [groupId]],
      [`update identity."group" set archived_at = $2 where group_id = $1`, [groupId, new Date(clock.now().getTime() - ago)]],
    ])
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    const result = await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
    expect(result.failed).toBe(0)
    return published.filter(event => event.type !== 'identity.retention-applied')
  }

  async function approve(approverId: string, change: PendingChange): Promise<PendingChange> {
    return approvals().decide({ subject: subject(approverId), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID })
  }

  /** A change in the platform group, requested by its owner and approved by the platform's second operator. */
  async function platformChange(request: unknown): Promise<PendingChange> {
    const change = await approvals().request({ subject: subject(platformOwner), request, correlationId: CORRELATION_ID })
    return approve(platformApprover, change)
  }

  async function groupRow(groupId: string) {
    const { rows } = await test.admin.query(`select state, name, settings, deleted_at from identity."group" where group_id = $1`, [groupId])
    return rows[0]
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    const platformSide = await tenant()
    platformTenant = platformSide.tenantId
    platform = platformSide.root
    platformOwner = platformSide.owner
    platformApprover = await person(platformTenant)
    homeTenant = (await tenant()).tenantId
  })

  beforeEach(async () => {
    allowed.clear()
    qualifying.clear()
    offset = 0
    for (const permission of ['identity.legal-holds:manage', 'identity.tenants:close']) {
      allow(platformOwner, permission, platform)
      qualify(platformApprover, permission, platform)
    }
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('group deletion', () => {
    it('refuses a group that is not archived, archived too recently, a root, or with a live child', async () => {
      const { root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      const child = await childGroup(groupId, owner)
      allow(owner, 'identity.groups:delete', groupId)
      allow(owner, 'identity.groups:delete', root)
      const request = (target: string) => approvals().request({ subject: subject(owner), request: { type: 'group.delete', target: { groupId: target }, justification }, correlationId: CORRELATION_ID })
      await expect(request(groupId)).rejects.toMatchObject({ code: 'conflict', message: 'only an archived group can be deleted' })
      await archive(child, 7 * DAY)
      await archive(groupId, HOUR)
      await expect(request(groupId)).rejects.toMatchObject({ code: 'conflict', message: 'delete its child groups first' })
      await archive(root, 30 * DAY)
      await expect(request(root)).rejects.toMatchObject({ code: 'conflict', message: 'a root group is deleted only when its tenant closes' })
      await seed(test.admin, [[`update identity."group" set state = 'deleted', deleted_at = now() where group_id = $1`, [child]]])
      await expect(request(groupId)).rejects.toMatchObject({ code: 'conflict', message: 'the group has not been archived for long enough' })
      await expect(approvals().request({ subject: subject(uuidv7()), request: { type: 'group.delete', target: { groupId: uuidv7() }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
    })

    it('deletes an archived group once approved: it confers nothing at once, and Identity keeps only a tombstone', async () => {
      const { tenantId, root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      const second = await person(homeTenant)
      const member = await person(homeTenant)
      const membershipId = await join(member, groupId)
      await archive(groupId, 8 * DAY)
      allow(owner, 'identity.groups:delete', groupId)
      qualify(second, 'identity.groups:delete', groupId)
      await events()
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.delete', target: { groupId }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ type: 'group.delete', risk: 'critical', route: 'approvers', state: 'awaiting-approval' })
      expect(await approve(second, change)).toMatchObject({ state: 'applied' })

      const published = await events()
      const ended = published.filter(event => event.type === 'membership.ended')
      expect(ended.map(event => event.data)).toEqual(expect.arrayContaining([expect.objectContaining({ membershipId, endReason: 'group-deleted' })]))
      expect(published.find(event => event.type === 'group.deleted')).toMatchObject({
        actorId: owner,
        data: { groupId, kind: 'standard', disposal: 'due', changeId: change.changeId },
      })
      expect(published.map(event => event.type).at(-1)).toBe('approval.decided')

      expect(await createDirectory(db, clock).describeGroup(groupId, { consistency: 'strong' })).toBeNull()
      expect(await groupRow(groupId)).toMatchObject({ state: 'deleted', name: null, settings: null })
      const { rows } = await test.admin.query('select count(*)::int as n from identity.membership where group_id = $1', [groupId])
      expect(rows[0].n).toBe(0)
      expect(await readDisposal(db, { kind: 'group', id: groupId })).toMatchObject({ state: 'due', confirmedBy: ['identity'] })
      // Nobody but the owner role touches a tombstone; a new group never takes its identifier.
      await expect(db.transaction(client => client.query(`update ${db.schema}."group" set name = 'Back', name_skeleton = 'back' where group_id = $1`, [groupId]), { tenantIds: [tenantId], actorId: owner, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
    })
  })

  describe('legal holds and disposal', () => {
    it('defers a held group\'s disposal until the hold ends, then disposes and announces it', async () => {
      const { root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      const hold = await platformChange({ type: 'legal-hold.place', target: { subjectKind: 'group', subjectId: groupId, endsAt: new Date(clock.now().getTime() + 20 * DAY).toISOString() }, justification })
      expect(hold).toMatchObject({ state: 'applied' })
      const placed = (await events()).find(event => event.type === 'legal-hold.placed')
      expect(placed).toMatchObject({ data: { subjectKind: 'group', subjectId: groupId, reasonCode: 'legal-order', holdId: hold.createdId } })
      expect(await legalHoldCovers(db, { kind: 'group', id: groupId }, clock)).toBe(true)

      await archive(groupId, 8 * DAY)
      const second = await person(homeTenant)
      allow(owner, 'identity.groups:delete', groupId)
      qualify(second, 'identity.groups:delete', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.delete', target: { groupId }, justification }, correlationId: CORRELATION_ID })
      await approve(second, change)
      expect((await events()).find(event => event.type === 'group.deleted')).toMatchObject({ data: { disposal: 'deferred' } })
      expect(await groupRow(groupId)).toMatchObject({ state: 'deleted' })
      expect((await groupRow(groupId)).name).not.toBeNull()
      expect(await recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'authorisation', eventId: uuidv7(), correlationId: CORRELATION_ID }, clock))
        .toEqual({ recorded: false })

      offset = 21 * DAY
      const result = await maintain()
      expect(result).toMatchObject({ endedLegalHolds: 1, disposalsDue: 1 })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(expect.arrayContaining(['legal-hold.ended', 'group.disposal-due']))
      expect(published.find(event => event.type === 'legal-hold.ended')).toMatchObject({ data: { endedHow: 'expired', changeId: null } })
      expect(await groupRow(groupId)).toMatchObject({ name: null, settings: null })
    })

    it('lets a tenant hold cover every group in it, and releasing it brings disposal due', async () => {
      const { tenantId, root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      const hold = await platformChange({ type: 'legal-hold.place', target: { subjectKind: 'tenant', subjectId: tenantId, endsAt: new Date(clock.now().getTime() + 365 * DAY).toISOString() }, justification })
      expect(await legalHoldCovers(db, { kind: 'group', id: groupId }, clock)).toBe(true)
      expect(await legalHoldCovers(db, { kind: 'tenant', id: tenantId }, clock)).toBe(true)
      expect(await legalHoldCovers(db, { kind: 'tenant', id: platformTenant }, clock)).toBe(false)

      await archive(groupId, 8 * DAY)
      const second = await person(homeTenant)
      allow(owner, 'identity.groups:delete', groupId)
      qualify(second, 'identity.groups:delete', groupId)
      await approve(second, await approvals().request({ subject: subject(owner), request: { type: 'group.delete', target: { groupId }, justification }, correlationId: CORRELATION_ID }))
      expect(await readDisposal(db, { kind: 'group', id: groupId })).toMatchObject({ state: 'deferred', dueAt: null })
      await events()

      expect(await platformChange({ type: 'legal-hold.release', target: { holdId: hold.createdId }, justification })).toMatchObject({ state: 'applied' })
      const published = await events()
      expect(published.find(event => event.type === 'legal-hold.ended')).toMatchObject({ data: { endedHow: 'released' } })
      expect(published.find(event => event.type === 'group.disposal-due')).toMatchObject({ data: { groupId, tenantId } })
      expect(await readDisposal(db, { kind: 'group', id: groupId })).toMatchObject({ state: 'due' })
      // A hold cannot be placed once disposal has started.
      await expect(approvals().request({ subject: subject(platformOwner), request: { type: 'legal-hold.place', target: { subjectKind: 'group', subjectId: groupId, endsAt: new Date(clock.now().getTime() + DAY).toISOString() }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'disposal has already started' })
    })

    it('records members\' confirmations and raises a disposal not confirmed within 7 days, every 7 days', async () => {
      const { root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      await archive(groupId, 8 * DAY)
      const second = await person(homeTenant)
      allow(owner, 'identity.groups:delete', groupId)
      qualify(second, 'identity.groups:delete', groupId)
      await approve(second, await approvals().request({ subject: subject(owner), request: { type: 'group.delete', target: { groupId }, justification }, correlationId: CORRELATION_ID }))
      const eventId = uuidv7()
      expect(await recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'authorisation', eventId, correlationId: CORRELATION_ID }, clock)).toEqual({ recorded: true })
      expect(await recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'authorisation', eventId, correlationId: CORRELATION_ID }, clock)).toEqual({ recorded: true })
      await expect(recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'Not A Member', eventId, correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'validation-failed' })
      // Each member issues its own event identifiers: Authorisation's are version 4 UUIDs.
      expect(await recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'authorisation', eventId: randomUUID(), correlationId: CORRELATION_ID }, clock)).toEqual({ recorded: true })
      await expect(recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'authorisation', eventId: 'not-a-uuid', correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'validation-failed' })
      await events()

      // Other tests' disposals share the database, so look only at this group's.
      const overdue = async () => (await events()).filter(event => event.type === 'group.disposal-overdue' && (event.data as { groupId: string }).groupId === groupId)
      offset = 6 * DAY
      await maintain()
      expect(await overdue()).toEqual([])
      offset = 8 * DAY
      await maintain()
      expect(await overdue()).toMatchObject([{ data: { groupId, members: ['profile'] } }])
      offset = 10 * DAY
      await maintain()
      expect(await overdue()).toEqual([])
      offset = 15 * DAY + HOUR
      await maintain()
      expect(await overdue()).toHaveLength(1)
      await recordDisposal(db, { subject: { kind: 'group', id: groupId }, member: 'profile', eventId: uuidv7(), correlationId: CORRELATION_ID }, clock)
      offset = 23 * DAY
      await maintain()
      expect(await overdue()).toEqual([])
      expect(await readDisposal(db, { kind: 'group', id: groupId })).toMatchObject({ confirmedBy: ['authorisation', 'identity', 'profile'] })
    })
  })

  describe('tenant lifecycle', () => {
    it('lets a root group\'s owner ask for shutdown, never approve it, and refuses protected tenants', async () => {
      const { tenantId, root, owner } = await tenant()
      allow(owner, 'identity.tenants:close', root)
      await join(owner, platform)
      qualify(owner, 'identity.tenants:close', platform)
      const close = (who: string, target = tenantId) => approvals().request({ subject: subject(who), request: { type: 'tenant.close', target: { tenantId: target }, justification }, correlationId: CORRELATION_ID })
      const change = await close(owner)
      expect(change).toMatchObject({ type: 'tenant.close', groupId: platform, route: 'approvers', state: 'awaiting-approval' })
      await expect(approve(owner, change)).rejects.toMatchObject({ code: 'conflict' })
      await expect(close(platformOwner, platformTenant)).rejects.toMatchObject({ code: 'conflict', message: 'the platform group\'s tenant cannot be closed' })
      await expect(close(platformOwner, homeTenant)).rejects.toMatchObject({ code: 'conflict', message: 'name another default home tenant first' })
      await expect(close(uuidv7())).rejects.toMatchObject({ code: 'forbidden' })
      const other = await tenant()
      const stranger = await person(other.tenantId)
      allow(stranger, 'identity.tenants:close', other.root)
      await expect(close(stranger)).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('closes after the notice period: people re-homed, every group deleted, the tenant a tombstone', async () => {
      const { tenantId, root, owner } = await tenant()
      const team = await childGroup(root, owner)
      const visitor = await person(homeTenant)
      await join(visitor, team)
      const farAway = await tenant('eu')
      const traveller = await person(farAway.tenantId)
      const travellerGroup = (await test.admin.query('select personal_group_id from identity.identity where identity_id = $1', [traveller])).rows[0].personal_group_id
      const { rows: before } = await test.admin.query('select personal_group_id from identity.identity where identity_id = $1', [owner])
      allow(owner, 'identity.tenants:close', root)
      await events()

      const change = await approve(platformApprover, await approvals().request({ subject: subject(owner), request: { type: 'tenant.close', target: { tenantId }, justification }, correlationId: CORRELATION_ID }))
      expect(change).toMatchObject({ state: 'applied' })
      const scheduled = await events()
      const closing = scheduled.find(event => event.type === 'tenant.closing')
      expect(Date.parse((closing!.data as { closesAt: string }).closesAt) - clock.now().getTime()).toBeGreaterThan(29 * DAY)
      expect(scheduled.filter(event => event.type === 'identity.rehoming-scheduled').map(event => (event.data as { identityId: string }).identityId)).toEqual([owner])

      // During the notice period: nothing new, and the governance export for a root group's owner.
      await expect(childGroup(team, owner)).rejects.toBeTruthy()
      allow(owner, 'identity.tenants:export', root)
      const exported = await createTenantExport({ db, access, policy: resolveIdentityPolicy(policyInput()), clock }).exportTenant({ subject: subject(owner), tenantId, correlationId: CORRELATION_ID })
      expect(exported.tenant).toMatchObject({ tenantId, state: 'closing' })
      expect(exported.groups.map(group => group.groupId).sort()).toEqual([root, team].sort())
      expect(exported.memberships.map(membership => membership.identityId)).toEqual(expect.arrayContaining([owner, visitor]))
      expect((await events()).map(event => event.type)).toEqual(['tenant.exported'])
      await expect(createTenantExport({ db, access, policy: resolveIdentityPolicy(policyInput()), clock }).exportTenant({ subject: subject(visitor), tenantId, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })

      offset = 31 * DAY
      expect(await maintain()).toMatchObject({ closedTenants: 1, blockedTenants: 0 })
      const published = await events()
      const rehomed = published.find(event => event.type === 'identity.rehomed')
      expect(rehomed).toMatchObject({ data: { identityId: owner, fromTenantId: tenantId, toTenantId: homeTenant, previousPersonalGroupId: before[0].personal_group_id, personalGroupId: before[0].personal_group_id } })
      const deleted = published.filter(event => event.type === 'group.deleted').map(event => (event.data as { groupId: string }).groupId)
      expect(deleted).toEqual([team, root])
      expect(published.find(event => event.type === 'tenant.closed')).toMatchObject({ data: { tenantId, disposal: 'due' } })
      const { rows } = await test.admin.query('select state, closed_at from identity.tenant where tenant_id = $1', [tenantId])
      expect(rows[0].state).toBe('closed')
      expect(await readDisposal(db, { kind: 'tenant', id: tenantId })).toMatchObject({ state: 'due', confirmedBy: ['identity'] })
      // The visitor's own account is untouched; the traveller's tenant was never involved.
      expect(await createProvisioning(db, resolveIdentityPolicy(), clock).signInStatus(visitor)).toMatchObject({ state: 'active' })
      expect((await test.admin.query('select personal_group_id from identity.identity where identity_id = $1', [traveller])).rows[0].personal_group_id).toBe(travellerGroup)
    })

    it('gives a person re-homed across data regions a new, empty personal group, and deletes the old one', async () => {
      const { tenantId, owner } = await tenant('eu')
      const { rows: before } = await test.admin.query('select personal_group_id from identity.identity where identity_id = $1', [owner])
      await platformChange({ type: 'tenant.close', target: { tenantId }, justification })
      offset = 31 * DAY
      await events()
      await maintain()
      const published = await events()
      const rehomed = published.find(event => event.type === 'identity.rehomed')!.data as { previousPersonalGroupId: string, personalGroupId: string }
      expect(rehomed.previousPersonalGroupId).toBe(before[0].personal_group_id)
      expect(rehomed.personalGroupId).not.toBe(rehomed.previousPersonalGroupId)
      expect(published.find(event => event.type === 'group.deleted' && (event.data as { groupId: string }).groupId === rehomed.previousPersonalGroupId))
        .toMatchObject({ data: { kind: 'personal', disposal: 'due' } })
      const actor = await createDirectory(db, clock).resolveActor(owner, { consistency: 'strong' })
      expect(actor?.personalGroup).toMatchObject({ groupId: rehomed.personalGroupId, tenantId: homeTenant })
    })

    it('can be cancelled during the notice period, leaving everything as it was', async () => {
      const { tenantId, owner } = await tenant()
      await platformChange({ type: 'tenant.close', target: { tenantId }, justification })
      await events()
      expect(await platformChange({ type: 'tenant.cancel-closing', target: { tenantId }, justification })).toMatchObject({ state: 'applied' })
      expect((await events()).map(event => event.type)).toEqual(expect.arrayContaining(['tenant.closing-cancelled', 'identity.rehoming-cancelled']))
      offset = 40 * DAY
      expect((await maintain()).closedTenants).toBe(0)
      const { rows } = await test.admin.query('select state from identity.tenant where tenant_id = $1', [tenantId])
      expect(rows[0].state).toBe('active')
      expect((await test.admin.query('select home_tenant_id from identity.identity where identity_id = $1', [owner])).rows[0].home_tenant_id).toBe(tenantId)
    })

    it('defers the disposal of a held tenant\'s groups and its own part', async () => {
      const { tenantId } = await tenant()
      await platformChange({ type: 'legal-hold.place', target: { subjectKind: 'tenant', subjectId: tenantId, endsAt: new Date(clock.now().getTime() + 90 * DAY).toISOString() }, justification })
      await platformChange({ type: 'tenant.close', target: { tenantId }, justification })
      offset = 31 * DAY
      await maintain()
      const published = await events()
      expect(published.filter(event => event.type === 'group.deleted').every(event => (event.data as { disposal: string }).disposal === 'deferred')).toBe(true)
      expect(published.find(event => event.type === 'tenant.closed')).toMatchObject({ data: { tenantId, disposal: 'deferred' } })
      offset = 91 * DAY
      await maintain()
      expect((await events()).map(event => event.type)).toEqual(expect.arrayContaining(['legal-hold.ended', 'group.disposal-due', 'tenant.disposal-due']))
      expect(await readDisposal(db, { kind: 'tenant', id: tenantId })).toMatchObject({ state: 'due' })
    })
  })

  describe('retention', () => {
    it('deletes decided changes and delivered events past their period, unless a hold covers them, and announces the counts', async () => {
      const { root, owner } = await tenant()
      const groupId = await childGroup(root, owner)
      const held = await childGroup(root, owner)
      const old = new Date(clock.now().getTime() - 800 * DAY)
      for (const target of [groupId, held]) {
        await seed(test.admin, [[
          `insert into identity.pending_change (change_id, type, tenant_id, group_id, requester_id, beneficiary_id, risk, reason_code, reference, target, created_id, internal,
             required_approvals, route, approvals, change_digest, delay_ends_at, expires_at, state, failure, correlation_id, created_at, decided_at, version)
           values ($1, 'group.archive', (select tenant_id from identity."group" where group_id = $2), $2, $3, null, 'high', 'tidy', null, jsonb_build_object('groupId', $2::text), null, '{}',
             1, 'approvers', '[]', repeat('0', 64), null, $4, 'expired', null, $5, $4, $4, 1)`,
          [uuidv7(), target, owner, old, CORRELATION_ID],
        ]])
      }
      await platformChange({ type: 'legal-hold.place', target: { subjectKind: 'group', subjectId: held, endsAt: new Date(clock.now().getTime() + 30 * DAY).toISOString() }, justification })
      await events()
      await seed(test.admin, [[`update identity.outbox set published_at = $1 where published_at is not null`, [new Date(clock.now().getTime() - 40 * DAY)]]])
      const { retention } = await maintain()
      expect(retention.governanceChanges).toBe(1)
      expect(retention.outboxEvents).toBeGreaterThan(0)
      const { rows } = await test.admin.query(`select group_id from identity.pending_change where reason_code = 'tidy'`)
      expect(rows.map(row => row.group_id)).toEqual([held])
      const published: IdentityEvent[] = []
      await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
      expect(published.find(event => event.type === 'identity.retention-applied')).toMatchObject({ data: { counts: { governanceChanges: 1 } } })
    })
  })
})
