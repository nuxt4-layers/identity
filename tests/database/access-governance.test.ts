import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentitySubject, PendingChange, SafetyPeriods } from '../../contracts'
import { DEFAULT_GROUP_SETTINGS, governedGroupSchema, identityPermissionRisk } from '../../contracts'
import {
  clearIdentityComposition,
  provideIdentityAccessDecision,
  provideIdentityApprovalPolicy,
  provideIdentityClock,
  provideIdentityDatabase,
  provideIdentityPolicy,
} from '../../server/utils/identity-composition'
import {
  bootstrapIdentityRootGroup,
  getIdentityAccessGovernance,
  getIdentityApprovals,
  getIdentityGovernance,
  getIdentityProvisioning,
  provisionIdentityTenant,
  recordIdentityCredentialRecovery,
} from '../../server/utils/identity-server'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Identity's access governance (docs/contracts.md §10.4) through its public
 * server function, as the host's adapter to Authorisation calls it: a
 * group's facts for one requester, and its owners in effect, read straight
 * from the database at the clock's time.
 */
describe.skipIf(!hasDatabase)('access governance on PostgreSQL', () => {
  let test: TestDatabase
  let offset = 0
  let tenant: string
  let platform: string
  let root: string
  let rootOwner: string

  const allowed = new Set<string>()
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const approvalPolicy: IdentityApprovalPolicy = {
    async riskOf(permission) {
      return identityPermissionRisk(permission)
    },
    async qualifies() {
      return false
    },
    async countQualifying() {
      return 0
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)
  const now = () => new Date(Date.now() + offset)
  const subject = (principalId: string): IdentitySubject => ({
    principalId,
    authenticatedAt: new Date(now().getTime() - 60_000).toISOString(),
    assurance: { level: 'aal2', phishingResistant: true },
  })
  const justification = { reasonCode: 'succession', reference: null }

  async function person(): Promise<string> {
    const provisioning = getIdentityProvisioning()
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  /** A child group of `parent`, founded by a fresh person, who is returned as its owner. */
  async function childGroup(parent = root): Promise<{ groupId: string, owner: string }> {
    const owner = await person()
    allow(owner, 'identity.groups:create', parent)
    const { groupId } = await getIdentityGovernance().createGroup({ subject: subject(owner), parentGroupId: parent, name: `Team ${uuidv7().slice(-8)}`, correlationId: CORRELATION_ID })
    return { groupId, owner }
  }

  async function join(identityId: string, groupId: string, options: { owner?: boolean, endsAt?: Date | null } = {}): Promise<string> {
    const membershipId = uuidv7()
    await seed(test.admin, [[
      `insert into identity.membership values ($1, $2, $3, (select tenant_id from identity."group" where group_id = $3), 'member', 'active', $4, false, $5, $6, null, null, null, now(), 1)`,
      [membershipId, identityId, groupId, options.owner ?? false, new Date(Date.now() - DAY), options.endsAt ?? null],
    ]])
    return membershipId
  }

  async function membershipOf(identityId: string, groupId: string): Promise<string> {
    const { rows } = await test.admin.query(`select membership_id from identity.membership where identity_id = $1 and group_id = $2 and state <> 'ended'`, [identityId, groupId])
    return rows[0].membership_id
  }

  /** Requests a change and has the tenant's root owner approve it, as the parent-owner route allows. */
  async function approvedChange(requester: string, permission: string, groupId: string, request: object): Promise<PendingChange> {
    allow(requester, permission, groupId)
    const change = await getIdentityApprovals().request({ subject: subject(requester), request, correlationId: CORRELATION_ID })
    expect(change.route).toBe('parent-owner')
    const decided = await getIdentityApprovals().decide({ subject: subject(rootOwner), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID })
    expect(decided.state).toBe('applied')
    return decided
  }

  /** Sets a group's own safety periods directly, as the migration role. */
  function setOwnPeriods(groupId: string, periods: SafetyPeriods): Promise<void> {
    return seed(test.admin, [[`update identity."group" set safety_periods = $2::jsonb where group_id = $1`, [groupId, JSON.stringify(periods)]]])
  }

  async function personalGroupOf(identityId: string): Promise<string> {
    const { rows } = await test.admin.query('select personal_group_id from identity.identity where identity_id = $1', [identityId])
    return rows[0].personal_group_id
  }

  const describeGroup = (groupId: string, identityId: string) => getIdentityAccessGovernance().describeGroup({ groupId, identityId, correlationId: CORRELATION_ID })

  beforeAll(async () => {
    test = await createTestDatabase()
    provideIdentityClock({ now })
    provideIdentityDatabase({ dialect: 'postgres', pool: test.runtime })
    provideIdentityAccessDecision(access)
    provideIdentityApprovalPolicy(approvalPolicy)

    const platformTenant = (await provisionIdentityTenant({ pool: test.admin, jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID })).tenantId
    provideIdentityPolicy({ defaultHomeTenantId: platformTenant })
    platform = (await bootstrapIdentityRootGroup({ pool: test.admin, tenantId: platformTenant, name: 'Platform', firstOwnerId: await person(), correlationId: CORRELATION_ID })).groupId

    tenant = (await provisionIdentityTenant({ pool: test.admin, jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID })).tenantId
    provideIdentityPolicy({ defaultHomeTenantId: tenant, platformGroupId: platform })
    rootOwner = await person()
    root = (await bootstrapIdentityRootGroup({ pool: test.admin, tenantId: tenant, name: 'Acme', firstOwnerId: rootOwner, correlationId: CORRELATION_ID })).groupId

    // The platform's values over the host's, and a root group's safer ones over both.
    await setOwnPeriods(platform, { publishedDelayHighHours: 96 })
    await setOwnPeriods(root, { publishedDelayCriticalHours: 240, recoveryHoldHours: 96 })
  })

  beforeEach(() => {
    allowed.clear()
    offset = 0
  })

  afterAll(async () => {
    clearIdentityComposition()
    await test?.drop()
  })

  it('describes a standard child group: its raised requirement, the periods in force, its parent and root', async () => {
    const { groupId: parent, owner: parentOwner } = await childGroup()
    const { groupId, owner } = await childGroup(parent)
    await setOwnPeriods(groupId, { approvalExpiryDays: 3 })
    const raised = { required: { low: 0, medium: 1, high: 2, critical: 2 }, referenceRequired: true }
    // The group's parent's owner is not the tenant's root owner: move the approval through the parent owner.
    allow(owner, 'identity.group-approvals:manage', groupId)
    const change = await getIdentityApprovals().request({ subject: subject(owner), request: { type: 'group.change-approvals', target: { groupId, approvals: raised }, justification }, correlationId: CORRELATION_ID })
    expect(change.route).toBe('parent-owner')
    await getIdentityApprovals().decide({ subject: subject(parentOwner), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID })

    const described = await describeGroup(groupId, owner)
    expect(governedGroupSchema.safeParse(described).success).toBe(true)
    expect(described).toEqual({
      groupId,
      tenantId: tenant,
      kind: 'standard',
      state: 'active',
      parentGroupId: parent,
      rootGroupId: root,
      personalOfIdentityId: null,
      approvals: raised,
      // High from the platform, critical and the hold from the root, the expiry from the group itself.
      safetyPeriods: { publishedDelayHighHours: 96, publishedDelayCriticalHours: 240, approvalExpiryDays: 3, recoveryHoldHours: 96 },
      requester: { recoveryHoldUntil: null, controls: [] },
    })
  })

  it('describes a root group as its own root, with no parent', async () => {
    expect(await describeGroup(root, rootOwner)).toMatchObject({
      groupId: root,
      parentGroupId: null,
      rootGroupId: root,
      approvals: DEFAULT_GROUP_SETTINGS.approvals,
      safetyPeriods: { publishedDelayHighHours: 96, publishedDelayCriticalHours: 240, approvalExpiryDays: 7, recoveryHoldHours: 96 },
    })
  })

  it('describes a personal group: whose it is, the default requirement and the platform\'s periods', async () => {
    const someone = await person()
    const personal = await personalGroupOf(someone)
    expect(await describeGroup(personal, someone)).toEqual({
      groupId: personal,
      tenantId: tenant,
      kind: 'personal',
      state: 'active',
      parentGroupId: null,
      rootGroupId: personal,
      personalOfIdentityId: someone,
      approvals: DEFAULT_GROUP_SETTINGS.approvals,
      safetyPeriods: { publishedDelayHighHours: 96, publishedDelayCriticalHours: 168, approvalExpiryDays: 7, recoveryHoldHours: 72 },
      requester: { recoveryHoldUntil: null, controls: [] },
    })
    // Asked for by someone else, it still says whose it is, so that Authorisation can tell.
    expect(await describeGroup(personal, rootOwner)).toMatchObject({ personalOfIdentityId: someone })
  })

  it('answers null for an unknown group, and refuses malformed input', async () => {
    expect(await describeGroup(uuidv7(), rootOwner)).toBeNull()
    await expect(describeGroup('not-a-group', rootOwner)).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(describeGroup(root, 'alice@example.test')).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(getIdentityAccessGovernance().describeGroup({ groupId: root, identityId: rootOwner, correlationId: 'x' })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(getIdentityAccessGovernance().countOwners({ groupId: root, excluding: ['alice'] })).rejects.toMatchObject({ code: 'validation-failed' })
  })

  it('shows the requester\'s recovery hold, by the periods in force for the group, until the clock passes it', async () => {
    const { groupId, owner } = await childGroup()
    const personal = await personalGroupOf(owner)
    const recoveredAt = now()
    expect(await recordIdentityCredentialRecovery({ identityId: owner, recoveredAt: recoveredAt.toISOString(), correlationId: CORRELATION_ID })).toEqual({ recorded: true })

    expect((await describeGroup(groupId, owner))?.requester.recoveryHoldUntil).toBe(new Date(recoveredAt.getTime() + 96 * HOUR).toISOString())
    expect((await describeGroup(personal, owner))?.requester.recoveryHoldUntil).toBe(new Date(recoveredAt.getTime() + 72 * HOUR).toISOString())
    // Another requester's facts are their own.
    expect((await describeGroup(groupId, rootOwner))?.requester.recoveryHoldUntil).toBeNull()

    offset = 73 * HOUR
    expect((await describeGroup(personal, owner))?.requester.recoveryHoldUntil).toBeNull()
    expect((await describeGroup(groupId, owner))?.requester.recoveryHoldUntil).toBe(new Date(recoveredAt.getTime() + 96 * HOUR).toISOString())
    offset = 97 * HOUR
    expect((await describeGroup(groupId, owner))?.requester.recoveryHoldUntil).toBeNull()
  })

  it('lists the service identities the requester created as identities they control', async () => {
    const { groupId, owner } = await childGroup()
    expect((await describeGroup(groupId, owner))?.requester.controls).toEqual([])
    const change = await approvedChange(owner, 'identity.service-identities:create', groupId, {
      type: 'service-identity.create',
      target: { groupId },
      justification: { reasonCode: 'integration', reference: null },
    })
    expect(change.createdId).not.toBeNull()
    expect((await describeGroup(groupId, owner))?.requester.controls).toEqual([change.createdId])
    expect((await describeGroup(root, owner))?.requester.controls).toEqual([change.createdId])
    // The approver controls nothing by approving.
    expect((await describeGroup(groupId, rootOwner))?.requester.controls).toEqual([])
  })

  it('follows owners as they are added and removed, excluding the identities named', async () => {
    const governance = getIdentityAccessGovernance()
    const { groupId, owner } = await childGroup()
    const second = await person()
    const membershipId = await join(second, groupId)
    expect(await governance.isOwner({ identityId: owner, groupId })).toBe(true)
    expect(await governance.isOwner({ identityId: second, groupId })).toBe(false)
    expect(await governance.isOwner({ identityId: owner, groupId: uuidv7() })).toBe(false)
    expect(await governance.countOwners({ groupId, excluding: [] })).toBe(1)

    await approvedChange(owner, 'identity.group-owners:manage', groupId, { type: 'group.add-owner', target: { membershipId }, justification })
    expect(await governance.isOwner({ identityId: second, groupId })).toBe(true)
    expect(await governance.countOwners({ groupId, excluding: [] })).toBe(2)
    expect(await governance.countOwners({ groupId, excluding: [owner] })).toBe(1)
    expect(await governance.countOwners({ groupId, excluding: [owner, second] })).toBe(0)

    await approvedChange(second, 'identity.group-owners:manage', groupId, { type: 'group.remove-owner', target: { membershipId: await membershipOf(owner, groupId) }, justification })
    expect(await governance.isOwner({ identityId: owner, groupId })).toBe(false)
    expect(await governance.countOwners({ groupId, excluding: [] })).toBe(1)
    expect(await governance.countOwners({ groupId, excluding: [second] })).toBe(0)
    expect(await governance.countOwners({ groupId: uuidv7(), excluding: [] })).toBe(0)
  })

  it('counts an owner only while their membership is in effect by the clock', async () => {
    const governance = getIdentityAccessGovernance()
    const { groupId } = await childGroup()
    const leaving = await person()
    await join(leaving, groupId, { owner: true, endsAt: new Date(Date.now() + DAY) })
    expect(await governance.isOwner({ identityId: leaving, groupId })).toBe(true)
    expect(await governance.countOwners({ groupId, excluding: [] })).toBe(2)
    offset = 2 * DAY
    expect(await governance.isOwner({ identityId: leaving, groupId })).toBe(false)
    expect(await governance.countOwners({ groupId, excluding: [] })).toBe(1)
  })

  it('reaches what spans tenants only through its definer function: the runtime role reads none of it directly', async () => {
    for (const table of ['identity', 'founding_claim', 'provisioning_request']) {
      await expect(test.runtime.query(`select * from identity.${table} limit 1`), table).rejects.toThrow(/permission denied/)
    }
    // Pending changes are tenant-isolated: without a tenant set, the runtime role sees none.
    expect((await test.runtime.query('select created_id from identity.pending_change')).rows).toEqual([])
    await expect(test.runtime.query('select identity.group_json($1)', [root])).rejects.toThrow(/permission denied/)
    const { rows } = await test.admin.query(`select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'identity' and p.proname = 'access_governance_facts'`)
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] }])
  })
})
