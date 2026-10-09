import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentityEvent, IdentitySubject, PendingChange, SafetyPeriods } from '../../contracts'
import { identityPermissionRisk, resolveIdentityPolicy } from '../../contracts'
import { createApprovals } from '../../server/internal/approvals'
import { bootstrapRootGroup, provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createGovernance } from '../../server/internal/governance'
import { createLifecycle } from '../../server/internal/lifecycle'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import { createQueries } from '../../server/internal/queries'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const HOUR = 3_600_000
const DAY = 24 * HOUR
const MANAGE = 'identity.group-approvals:manage'

describe.skipIf(!hasDatabase)('safety periods on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let platform: string
  let platformOwner: string
  let platformApprover: string
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
  const policy = () => resolveIdentityPolicy({ platformGroupId: platform })
  const approvals = () => createApprovals({ db, access, approvalPolicy, policy: policy(), clock })

  async function person(tenantId: string): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  /** A tenant with a root group founded by a fresh person. */
  async function tenantWithRoot(): Promise<{ tenantId: string, root: string, owner: string }> {
    const tenantId = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    const owner = await person(tenantId)
    const root = (await bootstrapRootGroup(operator, { tenantId, name: `Tenant ${uuidv7().slice(-8)}`, firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)).groupId
    return { tenantId, root, owner }
  }

  function requestPeriods(requester: string, groupId: string, safetyPeriods: SafetyPeriods, reference: string | null = null) {
    allow(requester, MANAGE, groupId)
    return approvals().request({
      subject: subject(requester),
      request: { type: 'group.change-safety-periods', target: { groupId, safetyPeriods }, justification: { reasonCode: 'policy-review', reference } },
      correlationId: CORRELATION_ID,
    })
  }

  function decide(approverId: string, change: PendingChange) {
    return approvals().decide({ subject: subject(approverId), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID })
  }

  /** Sets a group's own periods directly, as the migration role. */
  function setOwn(groupId: string, periods: SafetyPeriods): Promise<unknown> {
    return operator.transaction(client => client.query(`update ${test.schema}."group" set safety_periods = $2::jsonb where group_id = $1`, [groupId, JSON.stringify(periods)]), { correlationId: CORRELATION_ID })
  }

  async function stored(groupId: string): Promise<unknown> {
    const { rows } = await test.admin.query(`select safety_periods from ${test.schema}."group" where group_id = $1`, [groupId])
    return rows[0]?.safety_periods
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
    const platformTenant = await tenantWithRoot()
    platform = platformTenant.root
    platformOwner = platformTenant.owner
    platformApprover = await person(platformTenant.tenantId)
  })

  beforeEach(async () => {
    allowed.clear()
    qualifying.clear()
    qualify(platformApprover, MANAGE, platform)
    offset = 0
    await setOwn(platform, {})
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  it('applies a safer platform value as soon as it is approved, and announces it', async () => {
    const change = await requestPeriods(platformOwner, platform, { publishedDelayCriticalHours: 240 })
    expect(change).toMatchObject({ type: 'group.change-safety-periods', risk: 'critical', route: 'approvers', state: 'awaiting-approval' })
    expect(await decide(platformApprover, change)).toMatchObject({ state: 'applied' })
    expect(await stored(platform)).toEqual({ publishedDelayCriticalHours: 240 })
    const settings = (await events()).filter(event => event.type === 'group.settings-changed')
    expect(settings).toHaveLength(1)
    expect(settings[0]).toMatchObject({ data: { groupId: platform, changed: ['safetyPeriods'] } })
  })

  it('needs a risk-treatment reference to go below the deployment, and then waits out the old delay', async () => {
    await expect(requestPeriods(platformOwner, platform, { publishedDelayCriticalHours: 96 })).rejects.toMatchObject({ code: 'conflict', message: 'risk-treatment-required' })
    const change = await requestPeriods(platformOwner, platform, { publishedDelayCriticalHours: 96 }, 'RT-12')
    const held = (await events()).find(event => event.type === 'approval.held')
    expect(held).toMatchObject({ data: { changeId: change.changeId } })
    expect(Date.parse((held!.data as { heldUntil: string }).heldUntil) - Date.parse(change.createdAt)).toBe(168 * HOUR)

    const approved = await decide(platformApprover, change)
    expect(approved).toMatchObject({ state: 'delayed' })
    expect(Date.parse(approved.delayEndsAt!) - Date.parse(change.createdAt)).toBe(168 * HOUR)
    expect(await stored(platform)).toEqual({})

    offset = 167 * HOUR
    await runMaintenance(db, clock)
    expect(await stored(platform)).toEqual({})
    offset = 169 * HOUR
    await runMaintenance(db, clock)
    expect(await stored(platform)).toEqual({ publishedDelayCriticalHours: 96 })
  })

  it('lets a tenant only make periods safer, never set the platform-only grace period, and relax only by waiting', async () => {
    const { root, owner } = await tenantWithRoot()
    await expect(requestPeriods(owner, root, { publishedDelayCriticalHours: 100 })).rejects.toMatchObject({ code: 'conflict', message: 'safety-period-floor' })
    await expect(requestPeriods(owner, root, { approvalExpiryDays: 10 })).rejects.toMatchObject({ code: 'conflict', message: 'safety-period-floor' })
    await expect(requestPeriods(owner, root, { closureGraceDays: 60 })).rejects.toMatchObject({ code: 'conflict', message: 'platform-only' })

    // The sole owner of a root group: nobody can approve, so the published delay applies, at the current critical delay.
    const tighten = await requestPeriods(owner, root, { publishedDelayCriticalHours: 336, approvalExpiryDays: 3 })
    expect(tighten).toMatchObject({ route: 'published-delay', state: 'delayed' })
    expect(Date.parse(tighten.delayEndsAt!) - Date.parse(tighten.createdAt)).toBe(168 * HOUR)
    offset = 169 * HOUR
    await runMaintenance(db, clock)
    expect(await stored(root)).toEqual({ publishedDelayCriticalHours: 336, approvalExpiryDays: 3 })

    // Changes in the tenant now take the tenant's values, and relaxing them waits the tenant's longer delay.
    const relax = await requestPeriods(owner, root, {})
    expect(Date.parse(relax.delayEndsAt!) - Date.parse(relax.createdAt)).toBe(336 * HOUR)
  })

  it('applies the safest of platform, tenant and group to every change, and shows them on the group', async () => {
    const { root, owner } = await tenantWithRoot()
    await setOwn(root, { publishedDelayHighHours: 96 })
    await setOwn(platform, { publishedDelayHighHours: 120, approvalExpiryDays: 2 })
    allow(owner, 'identity.groups:create', root)
    const { groupId: child } = await createGovernance({ db, access, policy: policy(), clock }).createGroup({ subject: subject(owner), parentGroupId: root, name: 'Team', correlationId: CORRELATION_ID })
    await setOwn(child, { publishedDelayHighHours: 48, recoveryHoldHours: 100 })

    allow(owner, 'identity.groups:view', child)
    const view = await createQueries({ db, access, policy: policy(), clock }).group({ subject: subject(owner), groupId: child, correlationId: CORRELATION_ID })
    expect(view.safetyPeriods).toEqual({
      own: { publishedDelayHighHours: 48, recoveryHoldHours: 100 },
      effective: {
        publishedDelayHighHours: 120,
        publishedDelayCriticalHours: 168,
        approvalExpiryDays: 2,
        orphanRecoveryDelayDays: 14,
        recoveryHoldHours: 100,
        closureGraceDays: 30,
      },
      isPlatformGroup: false,
    })
  })

  it('refuses, in the database, a change recorded with a shorter delay or a longer expiry than the periods in force', async () => {
    const { root, owner } = await tenantWithRoot()
    await setOwn(root, { publishedDelayHighHours: 200, approvalExpiryDays: 2 })
    const record = (delayEndsAt: Date | null, expiresAt: Date | null, route: string) => db.transaction(client => client.query(
      `select ${test.schema}.record_change($1::jsonb)`,
      [JSON.stringify({
        type: 'group.archive', groupId: root, requesterId: owner, beneficiaryId: null, risk: 'high', reasonCode: 'tidy', reference: null,
        target: { groupId: root }, createdId: null, internal: {}, requiredApprovals: 1, route,
        delayEndsAt: delayEndsAt?.toISOString() ?? null, expiresAt: expiresAt?.toISOString() ?? null, correlationId: CORRELATION_ID, at: new Date().toISOString(),
      })],
    ), { actorId: owner, correlationId: CORRELATION_ID })
    const now = Date.now()
    await expect(record(new Date(now + 100 * HOUR), null, 'published-delay')).rejects.toMatchObject({ code: 'conflict' })
    await expect(record(null, new Date(now + 5 * DAY), 'approvers')).rejects.toMatchObject({ code: 'conflict' })
    await expect(record(null, new Date(now + 2 * DAY), 'approvers')).resolves.toBeDefined()
    await expect(record(new Date(now + 201 * HOUR), null, 'published-delay')).resolves.toBeDefined()
  })

  it('never lets the runtime role write safety periods itself', async () => {
    const { root } = await tenantWithRoot()
    await expect(test.runtime.query(`update ${test.schema}."group" set safety_periods = '{}'::jsonb where group_id = $1`, [root])).rejects.toThrow(/permission denied/)
    await expect(test.admin.query(`update ${test.schema}."group" set safety_periods = '{"publishedDelayHighHours": 1}'::jsonb where group_id = $1`, [root])).rejects.toThrow(/safety_periods_valid/)
  })

  it('closes accounts after the platform\'s grace period', async () => {
    await setOwn(platform, { closureGraceDays: 45 })
    const { tenantId } = await tenantWithRoot()
    const leaver = await person(tenantId)
    const { closesAt } = await createLifecycle({ db, policy: policy(), clock }).requestClosure({ subject: subject(leaver), correlationId: CORRELATION_ID })
    expect(Date.parse(closesAt) - clock.now().getTime()).toBeGreaterThan(45 * DAY - 60_000)
    expect(Date.parse(closesAt) - clock.now().getTime()).toBeLessThanOrEqual(45 * DAY)
  })
})
