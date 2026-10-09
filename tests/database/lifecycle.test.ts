import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentityEvent, IdentitySubject } from '../../contracts'
import { identityPermissionRisk, resolveIdentityPolicy } from '../../contracts'
import { createApprovals } from '../../server/internal/approvals'
import { bootstrapRootGroup, provisionBreakGlass, provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import { createBreakGlass } from '../../server/internal/break-glass'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createGovernance } from '../../server/internal/governance'
import { createJoining } from '../../server/internal/joining'
import { createLifecycle, recordCredentialRecovery } from '../../server/internal/lifecycle'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe.skipIf(!hasDatabase)('lifecycle, recovery and break-glass on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenant: string
  let platform: string
  let operatorPerson: string
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
    riskOf: async permission => identityPermissionRisk(permission),
    qualifies: async ({ approverId, permission, groupId }) => qualifying.has(`${approverId}|${permission}|${groupId}`),
    countQualifying: async ({ permission, groupId, excludingId, limit }) =>
      Math.min(limit, [...qualifying].filter(entry => entry.endsWith(`|${permission}|${groupId}`) && !entry.startsWith(`${excludingId}|`)).length),
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)
  const subject = (principalId: string, options: { ageSeconds?: number, level?: 'aal1' | 'aal2', phishingResistant?: boolean } = {}): IdentitySubject => ({
    principalId,
    authenticatedAt: new Date(clock.now().getTime() - (options.ageSeconds ?? 60) * 1000).toISOString(),
    assurance: { level: options.level ?? 'aal2', phishingResistant: options.phishingResistant ?? true },
  })
  const policy = () => resolveIdentityPolicy({ platformGroupId: platform })
  const lifecycle = () => createLifecycle({ db, policy: policy(), clock })
  const approvals = () => createApprovals({ db, access, approvalPolicy, policy: policy(), clock })
  const breakGlass = () => createBreakGlass({ db, access, policy: policy(), clock })
  const justification = { reasonCode: 'succession', reference: null }

  async function person(tenantId = tenant): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function join(identityId: string, groupId: string, options: { owner?: boolean, startsAt?: Date } = {}): Promise<string> {
    const membershipId = uuidv7()
    await seed(test.admin, [[
      `insert into identity.membership values ($1, $2, $3, (select tenant_id from identity."group" where group_id = $3), 'member', 'active', $4, false, $5, null, null, null, null, now(), 1)`,
      [membershipId, identityId, groupId, options.owner ?? false, options.startsAt ?? new Date(Date.now() - DAY)],
    ]])
    return membershipId
  }

  /** A new tenant whose root group has `owner` as its only owner. */
  async function rootGroup(): Promise<{ tenantId: string, groupId: string, owner: string }> {
    const tenantId = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    const owner = await person(tenantId)
    const { groupId } = await bootstrapRootGroup(operator, { tenantId, name: 'Root', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)
    return { tenantId, groupId, owner }
  }

  async function childOf(parent: string): Promise<{ groupId: string, owner: string }> {
    const owner = await person()
    allow(owner, 'identity.groups:create', parent)
    const { groupId } = await createGovernance({ db, access, policy: policy(), clock })
      .createGroup({ subject: subject(owner), parentGroupId: parent, name: `Team ${uuidv7().slice(-8)}`, correlationId: CORRELATION_ID })
    return { groupId, owner }
  }

  async function groupState(groupId: string): Promise<string> {
    return (await test.admin.query('select state from identity."group" where group_id = $1', [groupId])).rows[0].state
  }

  async function identityState(identityId: string): Promise<{ state: string, previous_state: string | null }> {
    return (await test.admin.query('select state, previous_state from identity.identity where identity_id = $1', [identityId])).rows[0]
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    const result = await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
    expect(result.failed).toBe(0)
    return published
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    tenant = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    operatorPerson = await person()
    platform = (await bootstrapRootGroup(operator, { tenantId: tenant, name: 'Platform', firstOwnerId: operatorPerson, correlationId: CORRELATION_ID }, clock)).groupId
  })

  beforeEach(async () => {
    allowed.clear()
    qualifying.clear()
    offset = 0
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('the identity lifecycle', () => {
    it('pauses after reauthentication, orphaning groups the person alone owned until they resume', async () => {
      const { groupId, owner } = await childOf(platform)
      await expect(lifecycle().pauseIdentity({ subject: subject(owner, { ageSeconds: 3600 }), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'insufficient-assurance' })
      await events()
      expect(await lifecycle().pauseIdentity({ subject: subject(owner), correlationId: CORRELATION_ID })).toEqual({ state: 'paused', orphanedGroupIds: [groupId] })
      expect(await groupState(groupId)).toBe('orphaned')
      expect((await events()).map(event => [event.type, event.data])).toEqual([
        ['group.orphaned', { groupId }],
        ['identity.paused', { identityId: owner }],
      ])
      await expect(lifecycle().pauseIdentity({ subject: subject(owner), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      expect(await lifecycle().resumeIdentity({ subject: subject(owner, { ageSeconds: 3600 }), correlationId: CORRELATION_ID })).toEqual({ state: 'active' })
      expect(await groupState(groupId)).toBe('active')
      expect((await events()).map(event => [event.type, event.data])).toEqual([
        ['group.recovered', { groupId, changeId: null, breakGlassReviewId: null }],
        ['identity.resumed', { identityId: owner }],
      ])
    })

    it('refuses closure while the person is the last owner, unless they leave the group to recovery, and cancels to the previous state', async () => {
      const { groupId, owner } = await childOf(platform)
      await expect(lifecycle().requestClosure({ subject: subject(owner), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict', message: 'last-owner' })
      expect(await lifecycle().lastOwnerOf({ subject: subject(owner) })).toEqual([groupId])
      await events()
      const requested = await lifecycle().requestClosure({ subject: subject(owner), leaveGroupsOrphaned: true, correlationId: CORRELATION_ID })
      expect(Date.parse(requested.closesAt) - clock.now().getTime()).toBeGreaterThan(29 * DAY)
      expect(await identityState(owner)).toEqual({ state: 'closure-pending', previous_state: 'active' })
      expect((await events()).find(event => event.type === 'identity.closure-requested')).toMatchObject({ data: { identityId: owner, closesAt: requested.closesAt } })
      expect(await groupState(groupId)).toBe('orphaned')
      expect(await lifecycle().cancelClosure({ subject: subject(owner), correlationId: CORRELATION_ID })).toEqual({ state: 'active' })
      expect(await identityState(owner)).toEqual({ state: 'active', previous_state: null })
      expect(await groupState(groupId)).toBe('active')
    })

    it('closes at the end of the grace period: memberships end, pending work is withdrawn, the closure is announced', async () => {
      const { groupId, owner } = await childOf(platform)
      const leaver = await person()
      const membershipId = await join(leaver, groupId)
      allow(owner, 'identity.invitations:manage', groupId)
      allow(leaver, 'identity.invitations:manage', groupId)
      const invitation = await createJoining({ db, access, policy: policy(), clock })
        .invite({ subject: subject(leaver), groupId, kind: 'member', correlationId: CORRELATION_ID })
      await lifecycle().requestClosure({ subject: subject(leaver), correlationId: CORRELATION_ID })
      await events()
      offset = 31 * DAY
      expect((await runMaintenance(db, clock)).closedIdentities).toBe(1)
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['membership.ended', 'identity.closed'])
      expect(published[0]).toMatchObject({ actorId: null, data: { membershipId, endReason: 'identity-closed' } })
      expect(published[1]).toMatchObject({ data: { identityId: leaver } })
      expect(await identityState(leaver)).toEqual({ state: 'closed', previous_state: null })
      const { rows } = await test.admin.query('select state from identity.invitation where invitation_id = $1', [invitation.invitationId])
      expect(rows[0].state).toBe('revoked')
      const signIn = await createProvisioning(db, policy(), clock).signInStatus(leaver)
      expect(signIn).toMatchObject({ state: 'closed', signIn: 'refused' })
    })
  })

  describe('orphaned-group recovery', () => {
    it('lets an owner above propose a member, another owner above approve, and announces the recovery', async () => {
      const second = await person()
      await join(second, platform, { owner: true })
      const { groupId, owner } = await childOf(platform)
      const member = await person()
      const membershipId = await join(member, groupId)
      await lifecycle().requestClosure({ subject: subject(owner), leaveGroupsOrphaned: true, correlationId: CORRELATION_ID })
      expect(await groupState(groupId)).toBe('orphaned')
      const stranger = await person()
      await expect(approvals().request({ subject: subject(stranger), request: { type: 'group.appoint-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      const change = await approvals().request({ subject: subject(operatorPerson), request: { type: 'group.appoint-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ type: 'group.appoint-owner', route: 'parent-owner', risk: 'critical', state: 'awaiting-approval', beneficiaryId: member })
      await events()
      expect(await approvals().decide({ subject: subject(second), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'applied' })
      expect(await groupState(groupId)).toBe('active')
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.recovered', 'group.owners-changed', 'approval.decided'])
      expect(published[0]).toMatchObject({ data: { groupId, changeId: change.changeId, breakGlassReviewId: null } })
      expect(published[1]).toMatchObject({ actorId: operatorPerson, data: { added: [member], removed: [], changeId: change.changeId } })
      await seed(test.admin, [[`update identity.membership set owner = false where identity_id = $1 and group_id = $2`, [second, platform]]])
    })

    it('lets the longest-standing member be proposed by a member where nobody owns above, after a delay any member may object to', async () => {
      const { groupId, owner } = await rootGroup()
      const eldest = await person()
      const younger = await person()
      const third = await person()
      const eldestMembership = await join(eldest, groupId, { startsAt: new Date(Date.now() - 30 * DAY) })
      const youngerMembership = await join(younger, groupId, { startsAt: new Date(Date.now() - 2 * DAY) })
      await join(third, groupId)
      await lifecycle().pauseIdentity({ subject: subject(owner), correlationId: CORRELATION_ID })
      expect(await groupState(groupId)).toBe('orphaned')

      await expect(approvals().request({ subject: subject(younger), request: { type: 'group.appoint-owner', target: { membershipId: youngerMembership }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      const change = await approvals().request({ subject: subject(younger), request: { type: 'group.appoint-owner', target: { membershipId: eldestMembership }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ route: 'published-delay', state: 'delayed' })
      expect(Date.parse(change.delayEndsAt!) - clock.now().getTime()).toBeGreaterThan(13 * DAY)
      expect(await approvals().getPendingChange({ subject: subject(third), changeId: change.changeId })).toEqual(change)

      // An objection stops automatic appointment; a platform operator decides.
      await expect(approvals().object({ subject: subject(younger), changeId: change.changeId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      await events()
      const objected = await approvals().object({ subject: subject(third), changeId: change.changeId, correlationId: CORRELATION_ID })
      expect(objected).toMatchObject({ route: 'platform-operator', state: 'awaiting-approval', delayEndsAt: null, approvals: [{ approverId: third, decision: 'object' }] })
      expect(objected.changeDigest).not.toBe(change.changeDigest)
      expect((await events()).map(event => [event.type, (event.data as { route?: string }).route])).toEqual([['approval.requested', 'platform-operator']])
      offset = 6 * DAY
      expect((await runMaintenance(db, clock)).appliedChanges).toBe(0)
      expect(await groupState(groupId)).toBe('orphaned')
      const platformOperator = await person()
      qualifying.add(`${platformOperator}|identity.orphaned-groups:recover|${platform}`)
      offset = 0
      await expect(approvals().decide({ subject: subject(await person()), changeId: change.changeId, changeDigest: objected.changeDigest, decision: 'approve', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      expect(await approvals().decide({ subject: subject(platformOperator), changeId: change.changeId, changeDigest: objected.changeDigest, decision: 'approve', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'applied' })
      expect(await groupState(groupId)).toBe('active')
    })

    it('appoints after the delay when nobody objects', async () => {
      const { groupId, owner } = await rootGroup()
      const eldest = await person()
      const eldestMembership = await join(eldest, groupId, { startsAt: new Date(Date.now() - 30 * DAY) })
      await lifecycle().pauseIdentity({ subject: subject(owner), correlationId: CORRELATION_ID })
      // The longest-standing member may propose themselves: the delay and objections stand in for an approver.
      const change = await approvals().request({ subject: subject(eldest), request: { type: 'group.appoint-owner', target: { membershipId: eldestMembership }, justification }, correlationId: CORRELATION_ID })
      offset = 13 * DAY
      expect((await runMaintenance(db, clock)).appliedChanges).toBe(0)
      offset = 15 * DAY
      expect((await runMaintenance(db, clock)).appliedChanges).toBe(1)
      expect((await approvals().getPendingChange({ subject: subject(eldest), changeId: change.changeId })).state).toBe('applied')
      expect(await groupState(groupId)).toBe('active')
    })
  })

  describe('the recovery hold', () => {
    it('holds a critical change requested soon after a credential recovery, and announces it', async () => {
      const { groupId, owner } = await childOf(platform)
      const member = await person()
      const membershipId = await join(member, groupId)
      allow(owner, 'identity.group-owners:manage', groupId)
      allow(owner, 'identity.groups:archive', groupId)
      expect(await recordCredentialRecovery(db, { identityId: owner, recoveredAt: clock.now().toISOString(), correlationId: CORRELATION_ID })).toEqual({ recorded: true })
      await events()
      const change = await approvals().request({ subject: subject(owner), request: { type: 'group.add-owner', target: { membershipId }, justification }, correlationId: CORRELATION_ID })
      const held = (await events()).find(event => event.type === 'approval.held')
      expect(held).toMatchObject({ data: { changeId: change.changeId, groupId } })
      expect(Date.parse((held!.data as { heldUntil: string }).heldUntil) - clock.now().getTime()).toBeGreaterThan(71 * HOUR)
      expect(await approvals().decide({ subject: subject(operatorPerson), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'delayed' })
      offset = 24 * HOUR
      await runMaintenance(db, clock)
      expect((await test.admin.query('select owner from identity.membership where membership_id = $1', [membershipId])).rows[0].owner).toBe(false)
      offset = 73 * HOUR
      expect((await runMaintenance(db, clock)).appliedChanges).toBeGreaterThanOrEqual(1)
      expect((await test.admin.query('select owner from identity.membership where membership_id = $1', [membershipId])).rows[0].owner).toBe(true)

      // A high change is not held.
      offset = 0
      await events()
      await approvals().request({ subject: subject(owner), request: { type: 'group.archive', target: { groupId }, justification }, correlationId: CORRELATION_ID })
      expect((await events()).map(event => event.type)).toEqual(['approval.requested'])
    })
  })

  describe('break-glass', () => {
    it('suspends at once, opens a review only another person closes, and announces the use', async () => {
      const glass = (await provisionBreakGlass(operator, { homeTenantId: tenant, correlationId: CORRELATION_ID }, clock)).identityId
      expect(await createProvisioning(db, policy(), clock).signInStatus(glass)).toMatchObject({ kind: 'break-glass', passkeyOnly: true })
      const target = await person()
      const someone = await person()
      await expect(breakGlass().act({ subject: subject(someone), action: 'suspend-identity', targetId: target, reasonCode: 'incident', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(breakGlass().act({ subject: subject(glass, { phishingResistant: false }), action: 'suspend-identity', targetId: target, reasonCode: 'incident', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'insufficient-assurance' })
      await events()
      const review = await breakGlass().act({ subject: subject(glass), action: 'suspend-identity', targetId: target, reasonCode: 'incident', correlationId: CORRELATION_ID })
      expect(review).toMatchObject({ action: 'suspend-identity', targetId: target, state: 'open', reasonCode: 'incident', tenantId: null })
      expect((await events()).map(event => [event.type, event.data])).toEqual([
        ['identity.suspended', { identityId: target, reasonCode: 'incident', changeId: null, breakGlassReviewId: review.reviewId }],
        ['break-glass.used', { reviewId: review.reviewId, breakGlassIdentityId: glass, action: 'suspend-identity', targetId: target, reasonCode: 'incident' }],
      ])
      expect((await identityState(target)).state).toBe('suspended')

      const closer = await person()
      await expect(breakGlass().closeReview({ subject: subject(closer), reviewId: review.reviewId, outcome: 'justified', closerHeldPasskey: false, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      allow(closer, 'identity.break-glass-reviews:close', platform)
      allow(glass, 'identity.break-glass-reviews:close', platform)
      await expect(breakGlass().closeReview({ subject: subject(closer), reviewId: review.reviewId, outcome: 'justified', closerHeldPasskey: true, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      await expect(breakGlass().closeReview({ subject: subject(glass), reviewId: review.reviewId, outcome: 'justified', closerHeldPasskey: false, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      await events()
      expect(await breakGlass().closeReview({ subject: subject(closer), reviewId: review.reviewId, outcome: 'justified', closerHeldPasskey: false, correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'closed', closedBy: closer, outcome: 'justified' })
      expect((await events()).map(event => [event.type, event.data])).toEqual([['break-glass.review-closed', { reviewId: review.reviewId, closedBy: closer, outcome: 'justified' }]])
    })

    it('suspends a membership, and appoints an owner only to an orphaned group', async () => {
      const glass = (await provisionBreakGlass(operator, { homeTenantId: tenant, correlationId: CORRELATION_ID }, clock)).identityId
      const { groupId, owner } = await childOf(platform)
      const member = await person()
      const membershipId = await join(member, groupId)
      await expect(breakGlass().act({ subject: subject(glass), action: 'appoint-owner', targetId: membershipId, reasonCode: 'incident', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      const ownerMembership = (await test.admin.query('select membership_id from identity.membership where identity_id = $1 and group_id = $2', [owner, groupId])).rows[0].membership_id
      await events()
      const suspension = await breakGlass().act({ subject: subject(glass), action: 'suspend-membership', targetId: ownerMembership, reasonCode: 'incident', correlationId: CORRELATION_ID })
      expect(suspension.tenantId).toBe(tenant)
      expect(await groupState(groupId)).toBe('orphaned')
      expect((await events()).map(event => event.type)).toEqual(['membership.suspended', 'group.orphaned', 'break-glass.used'])
      const appointment = await breakGlass().act({ subject: subject(glass), action: 'appoint-owner', targetId: membershipId, reasonCode: 'incident', correlationId: CORRELATION_ID })
      expect(await groupState(groupId)).toBe('active')
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['group.recovered', 'group.owners-changed', 'break-glass.used'])
      expect(published[1]).toMatchObject({ actorId: glass, data: { added: [member], breakGlassReviewId: appointment.reviewId, changeId: null } })
    })

    it('keeps reviews and credential recoveries out of the runtime role\'s reach', async () => {
      await expect(db.transaction(client => client.query('select * from identity.break_glass_review'))).rejects.toMatchObject({ code: 'forbidden' })
      await expect(db.transaction(client => client.query('update identity.identity set credentials_recovered_at = null'))).rejects.toMatchObject({ code: 'forbidden' })
    })
  })
})
