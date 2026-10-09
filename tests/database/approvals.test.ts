import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentityEvent, IdentityPolicyInput, IdentityRiskLevel, IdentitySubject, PendingChange } from '../../contracts'
import { DEFAULT_GROUP_SETTINGS, identityPermissionRisk, resolveIdentityPolicy } from '../../contracts'
import { createApprovals } from '../../server/internal/approvals'
import { bootstrapRootGroup, provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createGovernance } from '../../server/internal/governance'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const HOUR = 3_600_000

describe.skipIf(!hasDatabase)('governance approvals on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenant: string
  let root: string
  let platformOwner: string
  let offset = 0
  const clock: Clock = { now: () => new Date(Date.now() + offset) }

  /** Authorisation stand-ins: who may act, and who qualifies to approve, as (principal, permission, group) triples. */
  const allowed = new Set<string>()
  const qualifying = new Set<string>()
  const riskOverrides = new Map<string, IdentityRiskLevel | null>()
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const approvalPolicy: IdentityApprovalPolicy = {
    async riskOf(permission) {
      return riskOverrides.has(permission) ? riskOverrides.get(permission)! : identityPermissionRisk(permission)
    },
    async qualifies({ approverId, permission, groupId }) {
      return qualifying.has(`${approverId}|${permission}|${groupId}`)
    },
    async countQualifying({ permission, groupId, excludingId, limit }) {
      const n = [...qualifying].filter(entry => entry.endsWith(`|${permission}|${groupId}`) && !entry.startsWith(`${excludingId}|`)).length
      return Math.min(n, limit)
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)
  const qualify = (principalId: string, permission: string, groupId: string) => qualifying.add(`${principalId}|${permission}|${groupId}`)

  const subject = (principalId: string, assurance: Partial<IdentitySubject['assurance']> & { ageSeconds?: number } = {}): IdentitySubject => ({
    principalId,
    authenticatedAt: new Date(clock.now().getTime() - (assurance.ageSeconds ?? 60) * 1000).toISOString(),
    assurance: { level: assurance.level ?? 'aal2', phishingResistant: assurance.phishingResistant ?? true },
  })
  const approvals = (policy: IdentityPolicyInput = {}) =>
    createApprovals({ db, access, approvalPolicy, policy: resolveIdentityPolicy({ platformGroupId: root, ...policy }), clock })
  const governance = () => createGovernance({ db, access, policy: resolveIdentityPolicy(), clock })
  const justification = { reasonCode: 'succession', reference: null }

  async function person(tenantId = tenant): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function join(identityId: string, groupId: string, options: { owner?: boolean, kind?: string, endsAt?: Date | null, state?: string } = {}): Promise<string> {
    const membershipId = uuidv7()
    await seed(test.admin, [[
      `insert into identity.membership values ($1, $2, $3, (select tenant_id from identity."group" where group_id = $3), $4, $5, $6, false, $7, $8, null, null, $9, now(), 1)`,
      [membershipId, identityId, groupId, options.kind ?? 'member', options.state ?? 'active', options.owner ?? false, new Date(Date.now() - 86_400_000), options.endsAt ?? null, options.state === 'suspended' ? 'conduct' : null],
    ]])
    return membershipId
  }

  /** A child group of `parent`, founded by a fresh person, who is returned as its owner. */
  async function childGroup(parent = root, name = `Team ${uuidv7().slice(-8)}`): Promise<{ groupId: string, owner: string }> {
    const owner = await person()
    allow(owner, 'identity.groups:create', parent)
    const { groupId } = await governance().createGroup({ subject: subject(owner), parentGroupId: parent, name, correlationId: CORRELATION_ID })
    return { groupId, owner }
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    const result = await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
    expect(result.failed).toBe(0)
    return published
  }

  async function decide(approverId: string, change: PendingChange, decision: 'approve' | 'reject' = 'approve', assurance = {}) {
    return approvals().decide({ subject: subject(approverId, assurance), changeId: change.changeId, changeDigest: change.changeDigest, decision, correlationId: CORRELATION_ID })
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    tenant = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    platformOwner = await person()
    root = (await bootstrapRootGroup(operator, { tenantId: tenant, name: 'Platform', firstOwnerId: platformOwner, correlationId: CORRELATION_ID }, clock)).groupId
  })

  beforeEach(async () => {
    allowed.clear()
    qualifying.clear()
    riskOverrides.clear()
    offset = 0
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('bootstrapping a tenant', () => {
    it('creates the first root group with its founding owner, once, with the migration role only', async () => {
      const other = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
      const owner = await person(other)
      await events()
      await expect(bootstrapRootGroup(db, { tenantId: other, name: 'Acme', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'forbidden' })
      const { groupId } = await bootstrapRootGroup(operator, { tenantId: other, name: 'Acme', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.created', 'membership.added'])
      expect(published[0]).toMatchObject({ actorId: null, data: { groupId, lineage: [groupId], foundingOwnerId: owner } })
      expect(published[1]).toMatchObject({ data: { identityId: owner, groupId, owner: true } })
      await expect(bootstrapRootGroup(operator, { tenantId: other, name: 'Second', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'conflict' })
    })

    it('never lets the runtime role provision a tenant', async () => {
      await expect(provisionTenant(db, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'forbidden' })
    })
  })

  describe('requesting, approving and applying', () => {
    it('creates a root group once a qualifying approver approves the exact change, and announces each step', async () => {
      const requester = await person()
      const firstOwner = await person()
      const approver = await person()
      const stranger = await person()
      allow(requester, 'identity.root-groups:create', root)
      qualify(approver, 'identity.root-groups:create', root)
      await events()

      const change = await approvals().request({ subject: subject(requester), request: { type: 'group.create-root', target: { tenantId: tenant, name: '  Sales ', firstOwnerId: firstOwner }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ state: 'awaiting-approval', route: 'approvers', requiredApprovals: 1, risk: 'high', requesterId: requester, beneficiaryId: firstOwner, groupId: root, target: { name: 'Sales' } })
      expect(change.createdId).toMatch(/^[0-9a-f-]{36}$/)
      expect((await events()).map(event => [event.type, event.data])).toEqual([['approval.requested', {
        changeId: change.changeId, changeType: 'group.create-root', groupId: root, risk: 'high', route: 'approvers', requiredApprovals: 1, delayEndsAt: null,
      }]])

      // Neither the requester nor the beneficiary approves; nor does anyone who does not qualify.
      await expect(decide(requester, change)).rejects.toMatchObject({ code: 'conflict', message: 'own-request' })
      await expect(decide(firstOwner, change)).rejects.toMatchObject({ code: 'conflict', message: 'beneficiary' })
      await expect(decide(stranger, change)).rejects.toMatchObject({ code: 'forbidden' })
      // An approval binds to the digest the approver was shown.
      await expect(approvals().decide({ subject: subject(approver), changeId: change.changeId, changeDigest: 'b'.repeat(64), decision: 'approve', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'change-differs' })

      const decided = await decide(approver, change)
      expect(decided).toMatchObject({ state: 'applied', approvals: [{ approverId: approver, decision: 'approve', changeDigest: change.changeDigest, assurance: { level: 'aal2' } }] })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.created', 'membership.added', 'approval.decided'])
      expect(published[0]).toMatchObject({ actorId: requester, tenantId: tenant, data: { groupId: change.createdId, lineage: [change.createdId], foundingOwnerId: firstOwner } })
      expect(published[1]).toMatchObject({ data: { identityId: firstOwner, groupId: change.createdId, owner: true } })
      expect(published[2]).toMatchObject({ actorId: approver, aggregate: { type: 'approval', id: change.changeId }, data: { outcome: 'applied' } })
      expect(published.every(event => event.correlationId === CORRELATION_ID)).toBe(true)
      await expect(decide(approver, change)).rejects.toMatchObject({ code: 'conflict', message: 'not-pending' })
    })

    it('answers `forbidden` alike for an unknown target, a refused requester and an unknown change', async () => {
      const requester = await person()
      const { groupId } = await childGroup()
      await events()
      await expect(approvals().request({ subject: subject(requester), request: { type: 'group.archive', target: { groupId: uuidv7() }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(approvals().request({ subject: subject(requester), request: { type: 'group.archive', target: { groupId }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(approvals().getPendingChange({ subject: subject(requester), changeId: uuidv7() })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(approvals().decide({ subject: subject(requester), changeId: uuidv7(), changeDigest: 'a'.repeat(64), decision: 'approve', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(approvals().request({ subject: subject(requester), request: { type: 'group.archive', target: { groupId }, justification: { reasonCode: 'Because', reference: null } }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'validation-failed' })
      expect(await events()).toEqual([])
    })

    it('refuses a self-grant at any risk level, before anything is recorded', async () => {
      const { groupId, owner } = await childGroup()
      const membershipId = await join(owner, root)
      allow(owner, 'identity.group-owners:manage', root)
      allow(owner, 'identity.memberships:schedule', groupId)
      await events()
      await expect(approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'self-grant' })
      const own = (await test.admin.query(`select membership_id from identity.membership where identity_id = $1 and group_id = $2`, [owner, groupId])).rows[0].membership_id
      await expect(approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId: own, startsAt: new Date().toISOString(), endsAt: null }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'self-grant' })
      expect(await events()).toEqual([])
    })

    it('demands the step-up the risk sets, of requesters and approvers alike, and never below the catalogue\'s risk', async () => {
      const { groupId, owner } = await childGroup()
      const member = await person()
      const membershipId = await join(member, groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const request = { type: 'group.add-owner', target: { membershipId }, justification }
      await expect(approvals().request({ subject: subject(owner, { phishingResistant: false }), request, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'insufficient-assurance' })
      await expect(approvals().request({ subject: subject(owner, { ageSeconds: 3600 }), request, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'insufficient-assurance' })
      const change = await approvals().request({ subject: subject(owner), request, correlationId: CORRELATION_ID })
      await expect(decide(platformOwner, change, 'approve', { ageSeconds: 3600 })).rejects.toMatchObject({ code: 'insufficient-assurance' })

      // A catalogue that raises a risk raises the requirement; one missing the permission refuses.
      allow(owner, 'identity.memberships:schedule', groupId)
      riskOverrides.set('identity.memberships:schedule', 'high')
      const scheduled = await approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId, startsAt: new Date().toISOString(), endsAt: null }, justification }, correlationId: CORRELATION_ID })
      expect(scheduled).toMatchObject({ risk: 'high', requiredApprovals: 1, state: 'awaiting-approval' })
      riskOverrides.set('identity.memberships:schedule', null)
      await expect(approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId, startsAt: new Date().toISOString(), endsAt: null }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'unavailable' })
    })

    it('routes to an owner of the parent group when nobody else in the group qualifies, and makes the owner', async () => {
      const { groupId, owner } = await childGroup()
      const member = await person()
      const membershipId = await join(member, groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ route: 'parent-owner', requiredApprovals: 1, risk: 'critical', beneficiaryId: member })
      expect(await approvals().getPendingChange({ subject: subject(platformOwner), changeId: change.changeId })).toEqual(change)
      expect(await approvals().getPendingChange({ subject: subject(member), changeId: change.changeId })).toEqual(change)
      await expect(approvals().getPendingChange({ subject: subject(await person()), changeId: change.changeId })).rejects.toMatchObject({ code: 'forbidden' })
      await events()

      expect(await decide(platformOwner, change)).toMatchObject({ state: 'applied' })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.owners-changed', 'approval.decided'])
      expect(published[0]).toMatchObject({ aggregate: { type: 'group', id: groupId, version: 2 }, data: { groupId, added: [member], removed: [], changeId: change.changeId, breakGlassReviewId: null } })
      const { rows } = await test.admin.query('select owner from identity.membership where membership_id = $1', [membershipId])
      expect(rows[0].owner).toBe(true)
    })

    it('needs a published delay when nobody can approve, and applies it when the delay ends unless cancelled', async () => {
      const other = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
      const owner = await person(other)
      const lonely = (await bootstrapRootGroup(operator, { tenantId: other, name: 'Solo', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)).groupId
      allow(owner, 'identity.group-settings:manage', lonely)
      const { approvals: _approvals, ...settings } = DEFAULT_GROUP_SETTINGS
      const request = { type: 'group.change-settings', target: { groupId: lonely, settings: { ...settings, onArchive: 'end-memberships' } }, justification }
      const change = await approvals().request({ subject: subject(owner), request, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ route: 'published-delay', state: 'delayed', expiresAt: null })
      expect(Date.parse(change.delayEndsAt!) - clock.now().getTime()).toBeGreaterThan(71 * HOUR)
      await expect(decide(await person(), change)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(approvals().cancel({ subject: subject(await person()), changeId: change.changeId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await events()

      expect(await runMaintenance(db, clock)).toMatchObject({ appliedChanges: 0 })
      offset = 73 * HOUR
      expect(await runMaintenance(db, clock)).toMatchObject({ appliedChanges: 1, rejectedChanges: 0 })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.settings-changed', 'approval.decided'])
      expect(published[0]).toMatchObject({ actorId: owner, correlationId: CORRELATION_ID, data: { groupId: lonely, changed: ['onArchive'] } })
      expect(published[1]).toMatchObject({ actorId: null, data: { outcome: 'applied' } })

      // Another, cancelled by its requester, never applies.
      const second = await approvals().request({ subject: subject(owner), request: { ...request, target: { groupId: lonely, settings } }, correlationId: CORRELATION_ID })
      expect(await approvals().cancel({ subject: subject(owner), changeId: second.changeId, correlationId: CORRELATION_ID })).toMatchObject({ state: 'cancelled' })
      offset += 200 * HOUR
      expect(await runMaintenance(db, clock)).toMatchObject({ appliedChanges: 0 })
      expect((await events()).filter(event => event.aggregate.id === second.changeId).map(event => [event.type, (event.data as { outcome?: string }).outcome]))
        .toEqual([['approval.requested', undefined], ['approval.decided', 'cancelled']])
    })

    it('expires a change nobody approves in time, and records an approver\'s rejection', async () => {
      const { groupId, owner } = await childGroup()
      const first = await join(await person(), groupId)
      const second = await join(await person(), groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const expiring = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId: first }, justification }, correlationId: CORRELATION_ID })
      const rejected = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId: second }, justification }, correlationId: CORRELATION_ID })
      expect(await decide(platformOwner, rejected, 'reject')).toMatchObject({ state: 'rejected' })
      await events()
      offset = 7 * 24 * HOUR + HOUR
      expect(await decide(platformOwner, expiring)).toMatchObject({ state: 'expired' })
      expect((await events()).map(event => [event.type, (event.data as { outcome?: string }).outcome])).toEqual([['approval.decided', 'expired']])
      const { rows } = await test.admin.query('select count(*)::int as n from identity.membership where membership_id = any ($1) and owner', [[first, second]])
      expect(rows[0].n).toBe(0)
    })

    it('checks every rule again when the change applies, and rejects it if one no longer holds', async () => {
      const { groupId, owner } = await childGroup()
      const member = await person()
      const membershipId = await join(member, groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      await governance().leaveGroup({ subject: subject(member), membershipId, correlationId: CORRELATION_ID })
      await events()
      expect(await decide(platformOwner, change)).toMatchObject({ state: 'rejected' })
      expect((await events()).map(event => [event.type, (event.data as { outcome?: string }).outcome])).toEqual([['approval.decided', 'rejected']])
      const { rows } = await test.admin.query('select failure from identity.pending_change where change_id = $1', [change.changeId])
      expect(rows[0].failure).toBe('identity:membership-ended')
    })

    it('refuses an approval if the recorded change was altered after it was requested', async () => {
      const { groupId, owner } = await childGroup()
      const membershipId = await join(await person(), groupId)
      const intruder = await join(await person(), groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      await test.admin.query(`update identity.pending_change set target = jsonb_build_object('membershipId', $2::text) where change_id = $1`, [change.changeId, intruder])
      await expect(decide(platformOwner, change)).rejects.toMatchObject({ code: 'conflict' })
      const { rows } = await test.admin.query('select owner from identity.membership where membership_id = $1', [intruder])
      expect(rows[0].owner).toBe(false)
    })
  })

  describe('owners', () => {
    it('demotes and suspends an owner with approval, never the last active owner', async () => {
      const { groupId, owner } = await childGroup()
      const second = await person()
      const secondMembership = await join(second, groupId, { owner: true })
      const ownerMembership = (await test.admin.query(`select membership_id from identity.membership where identity_id = $1 and group_id = $2`, [owner, groupId])).rows[0].membership_id
      allow(owner, 'identity.group-owners:manage', groupId)
      allow(second, 'identity.group-owners:manage', groupId)
      await expect(approvals().request({ subject: subject(owner), request: { type: 'group.suspend-owner', target: { membershipId: ownerMembership }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      const suspend = await approvals().request({ subject: subject(owner), request: { type: 'group.suspend-owner', target: { membershipId: secondMembership }, justification: { reasonCode: 'conduct', reference: null } }, correlationId: CORRELATION_ID })
      await events()
      expect(await decide(platformOwner, suspend)).toMatchObject({ state: 'applied' })
      expect((await events())[0]).toMatchObject({ type: 'membership.suspended', data: { membershipId: secondMembership, reasonCode: 'conduct', changeId: suspend.changeId } })
      // The suspended owner no longer counts: the remaining one cannot be demoted.
      await expect(approvals().request({ subject: subject(second), request: { type: 'group.remove-owner', target: { membershipId: ownerMembership }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'last-owner' })
      const { rows } = await test.admin.query(`select ${test.schema}.active_owner_count($1, '{}') as n`, [groupId])
      expect(rows[0].n).toBe(1)
    })

    it('keeps the runtime role from suspending or removing an owner, or reinstating a suspension, directly', async () => {
      const { groupId, owner } = await childGroup()
      const ownerMembership = (await test.admin.query(`select membership_id from identity.membership where identity_id = $1 and group_id = $2`, [owner, groupId])).rows[0].membership_id
      const suspended = await join(await person(), groupId, { state: 'suspended' })
      const context = { tenantIds: [tenant], actorId: owner, correlationId: CORRELATION_ID }
      await expect(db.transaction(client => client.query(`update identity.membership set state = 'suspended', reason_code = 'x' where membership_id = $1`, [ownerMembership]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`update identity.membership set state = 'ended', ended_at = now(), end_reason = 'removed' where membership_id = $1`, [ownerMembership]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`update identity.membership set state = 'active' where membership_id = $1`, [suspended]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`update identity.membership set owner = true where membership_id = $1`, [suspended]), context))
        .rejects.toMatchObject({ code: 'forbidden' })
    })
  })

  describe('memberships', () => {
    it('reinstates a suspended member at once when no approver is required, naming the change', async () => {
      const { groupId, owner } = await childGroup()
      const member = await person()
      const membershipId = await join(member, groupId, { state: 'suspended' })
      allow(owner, 'identity.memberships:suspend', groupId)
      await events()
      const change = await approvals().request({ subject: subject(owner, { level: 'aal1', phishingResistant: false }), request: { type: 'membership.reinstate', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ state: 'applied', route: 'none', requiredApprovals: 0, risk: 'medium' })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['membership.reinstated'])
      expect(published[0]).toMatchObject({ actorId: owner, data: { membershipId, changeId: change.changeId } })
    })

    it('renews a guest within the group\'s guest term, and refuses a longer one', async () => {
      const { groupId, owner } = await childGroup()
      const guest = await person()
      const membershipId = await join(guest, groupId, { kind: 'guest', endsAt: new Date(Date.now() + 10 * 24 * HOUR) })
      allow(owner, 'identity.memberships:schedule', groupId)
      const startsAt = new Date(Date.now() - 86_400_000).toISOString()
      const tooLong = new Date(Date.now() + 120 * 24 * HOUR).toISOString()
      await expect(approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId, startsAt, endsAt: tooLong }, justification: { reasonCode: 'renewal', reference: null } }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'identity:guest-term' })
      await expect(approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId, startsAt, endsAt: null }, justification: { reasonCode: 'renewal', reference: null } }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      const endsAt = new Date(Date.now() + 80 * 24 * HOUR).toISOString()
      await events()
      const change = await approvals().request({ subject: subject(owner), request: { type: 'membership.schedule', target: { membershipId, startsAt, endsAt }, justification: { reasonCode: 'renewal', reference: null } }, correlationId: CORRELATION_ID })
      expect(change.state).toBe('applied')
      expect((await events())).toEqual([expect.objectContaining({ type: 'membership.dates-changed', data: expect.objectContaining({ membershipId, endsAt }) })])
    })
  })

  describe('groups', () => {
    it('reparents within the tenant, refusing cycles, and announces the old and new lineage', async () => {
      const { groupId: a, owner } = await childGroup()
      allow(owner, 'identity.groups:create', a)
      const { groupId: b } = await governance().createGroup({ subject: subject(owner), parentGroupId: a, name: 'Inner', correlationId: CORRELATION_ID })
      const { groupId: c, owner: other } = await childGroup()
      allow(owner, 'identity.groups:reparent', a)
      allow(owner, 'identity.groups:reparent', b)
      allow(owner, 'identity.groups:reparent', c)
      await expect(approvals().request({ subject: subject(owner), request: { type: 'group.reparent', target: { groupId: a, parentGroupId: b }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'would create a cycle' })
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.reparent', target: { groupId: b, parentGroupId: c }, justification }, correlationId: CORRELATION_ID })
      // The requester is the only owner of the parent group, so an owner of the tenant's root group decides.
      expect(change.route).toBe('tenant-owner')
      await events()
      await expect(decide(other, change)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await decide(platformOwner, change)).toMatchObject({ state: 'applied' })
      const published = await events()
      expect(published[0]).toMatchObject({ type: 'group.reparented', data: { groupId: b, previousLineage: [root, a, b], lineage: [root, c, b], changeId: change.changeId } })
    })

    it('archives a group only once its children are archived, ending memberships when its settings say so', async () => {
      const { groupId: parent, owner } = await childGroup()
      allow(owner, 'identity.groups:create', parent)
      const { groupId: child } = await governance().createGroup({ subject: subject(owner), parentGroupId: parent, name: 'Leaf', correlationId: CORRELATION_ID })
      allow(owner, 'identity.groups:archive', parent)
      const blocked = await approvals().request({ subject: subject(owner), request: { type: 'group.archive', target: { groupId: parent }, justification }, correlationId: CORRELATION_ID })
      expect(await decide(platformOwner, blocked)).toMatchObject({ state: 'rejected' })
      await seed(test.admin, [
        [`update identity."group" set state = 'archived' where group_id = $1`, [child]],
        [`update identity."group" set settings = jsonb_set(settings, '{onArchive}', '"end-memberships"') where group_id = $1`, [parent]],
      ])
      const member = await join(await person(), parent)
      await events()
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.archive', target: { groupId: parent }, justification }, correlationId: CORRELATION_ID })
      expect(await decide(platformOwner, change)).toMatchObject({ state: 'applied' })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['approval.requested', 'membership.ended', 'membership.ended', 'group.archived', 'approval.decided'])
      expect(published.find(event => event.type === 'membership.ended' && event.data.membershipId === member)).toMatchObject({ data: { endReason: 'group-archived' } })
      expect(published[3]).toMatchObject({ data: { groupId: parent, changeId: change.changeId } })
    })

    it('raises approval requirements, which then apply to the group\'s own changes', async () => {
      const { groupId, owner } = await childGroup()
      allow(owner, 'identity.group-approvals:manage', groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      const raise = await approvals().request({
        subject: subject(owner),
        request: { type: 'group.change-approvals', target: { groupId, approvals: { required: { low: 0, medium: 1, high: 2, critical: 2 }, referenceRequired: true } }, justification },
        correlationId: CORRELATION_ID,
      })
      expect(await decide(platformOwner, raise)).toMatchObject({ state: 'applied' })
      const membershipId = await join(await person(), groupId)
      await expect(approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'validation-failed', message: 'reference-missing' })
      const first = await person()
      const second = await person()
      qualify(first, 'identity.group-owners:manage', groupId)
      qualify(second, 'identity.group-owners:manage', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification: { reasonCode: 'succession', reference: 'CHG-1042' } }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ route: 'approvers', requiredApprovals: 2 })
      expect(await decide(first, change)).toMatchObject({ state: 'awaiting-approval' })
      await expect(decide(first, change)).rejects.toMatchObject({ code: 'conflict', message: 'already-decided' })
      expect(await decide(second, change)).toMatchObject({ state: 'applied' })
    })
  })

  describe('identities', () => {
    it('suspends and reinstates an identity through the platform group, announcing the change', async () => {
      const requester = await person()
      const approver = await person()
      const target = await person()
      allow(requester, 'identity.identities:suspend', root)
      qualify(approver, 'identity.identities:suspend', root)
      const suspend = await approvals().request({ subject: subject(requester), request: { type: 'identity.suspend', target: { identityId: target }, justification: { reasonCode: 'legal-order', reference: null } }, correlationId: CORRELATION_ID })
      await events()
      expect(await decide(approver, suspend)).toMatchObject({ state: 'applied' })
      expect((await events())[0]).toMatchObject({ type: 'identity.suspended', tenantId: null, data: { identityId: target, reasonCode: 'legal-order', changeId: suspend.changeId, breakGlassReviewId: null } })
      expect((await test.admin.query('select state, previous_state from identity.identity where identity_id = $1', [target])).rows[0]).toEqual({ state: 'suspended', previous_state: 'active' })

      const reinstate = await approvals().request({ subject: subject(requester), request: { type: 'identity.reinstate', target: { identityId: target }, justification }, correlationId: CORRELATION_ID })
      expect(await decide(approver, reinstate)).toMatchObject({ state: 'applied' })
      expect((await events()).map(event => event.type)).toEqual(['approval.requested', 'identity.reinstated', 'approval.decided'])
      expect((await test.admin.query('select state from identity.identity where identity_id = $1', [target])).rows[0].state).toBe('active')
    })

    it('refuses platform-wide changes when the host names no platform group', async () => {
      const requester = await person()
      allow(requester, 'identity.identities:suspend', root)
      await expect(approvals({ platformGroupId: null }).request({ subject: subject(requester), request: { type: 'identity.suspend', target: { identityId: await person() }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
    })

    it('creates a service identity owned by the group, with the identifier given when it was requested', async () => {
      const { groupId, owner } = await childGroup()
      allow(owner, 'identity.service-identities:create', groupId)
      const change = await approvals().request({ subject: subject(owner), request: { type: 'service-identity.create', target: { groupId }, justification: { reasonCode: 'integration', reference: null } }, correlationId: CORRELATION_ID })
      expect(await decide(platformOwner, change)).toMatchObject({ state: 'applied' })
      const published = await events()
      expect(published).toContainEqual(expect.objectContaining({ type: 'identity.provisioned', data: { identityId: change.createdId, kind: 'service', homeTenantId: tenant, personalGroupId: null } }))
      expect((await test.admin.query('select kind, owner_group_id from identity.identity where identity_id = $1', [change.createdId])).rows[0]).toEqual({ kind: 'service', owner_group_id: groupId })
    })
  })

  describe('the database holds the rules too', () => {
    it('lets the runtime role found a group only for its own actor, and never claim a founder', async () => {
      const actor = await person()
      const other = await person()
      const groupId = uuidv7()
      const context = { tenantIds: [tenant], actorId: actor, correlationId: CORRELATION_ID }
      const found = (founder: string) => db.transaction(async (client) => {
        await client.query(`insert into identity."group" (group_id, tenant_id, kind, parent_group_id, name, name_skeleton, external_id, state, settings, created_at, version)
          values ($1, $2, 'standard', $3, 'Forged', 'forged', null, 'active', '{}'::jsonb, now(), 1)`, [groupId, tenant, root])
        await client.query(`insert into identity.membership values (identity.uuid_v7(), $1, $2, $3, 'member', 'active', true, true, now(), null, null, null, null, now(), 1)`, [founder, groupId, tenant])
      }, context)
      await expect(found(other)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query(`insert into identity.founding_claim values ($1, $2)`, [groupId, other]), context)).rejects.toMatchObject({ code: 'forbidden' })
      await events()
      await found(actor)
      expect((await events())[0]).toMatchObject({ type: 'group.created', data: { groupId, foundingOwnerId: actor } })
    })

    it('refuses a recorded change below the risk or requirement floor, or a self-grant, whatever the caller sends', async () => {
      const { groupId, owner } = await childGroup()
      const membershipId = (await test.admin.query(`select membership_id from identity.membership where identity_id = $1 and group_id = $2`, [owner, groupId])).rows[0].membership_id
      const base = {
        type: 'group.add-owner', groupId, requesterId: owner, beneficiaryId: await person(), risk: 'critical', reasonCode: 'x', reference: null,
        target: { membershipId }, createdId: null, internal: {}, requiredApprovals: 0, route: 'none', delayEndsAt: null, expiresAt: null,
        correlationId: CORRELATION_ID, at: new Date().toISOString(),
      }
      const record = (input: object) => db.transaction(client => client.query(`select identity.record_change($1::jsonb)`, [JSON.stringify(input)]), { tenantIds: [tenant], actorId: owner, correlationId: CORRELATION_ID })
      await expect(record(base)).rejects.toMatchObject({ code: 'conflict', message: 'identity:approval-floor' })
      await expect(record({ ...base, risk: 'low', requiredApprovals: 0 })).rejects.toMatchObject({ code: 'conflict', message: 'identity:approval-floor' })
      await expect(record({ ...base, beneficiaryId: owner, requiredApprovals: 1, route: 'approvers', expiresAt: new Date(Date.now() + HOUR).toISOString() }))
        .rejects.toMatchObject({ code: 'conflict', message: 'identity:self-grant' })
      await expect(record({ ...base, requiredApprovals: 1, route: 'published-delay', delayEndsAt: new Date(Date.now() + HOUR).toISOString() }))
        .rejects.toMatchObject({ code: 'conflict', message: 'identity:approval-floor' })
      const { rows } = await test.admin.query('select count(*)::int as n from identity.pending_change where group_id = $1', [groupId])
      expect(rows[0].n).toBe(0)
    })
  })

})
