import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityApprovalPolicy, IdentityEvent, IdentityPolicyInput, IdentitySubject, PendingChange } from '../../contracts'
import { identityPermissionRisk, resolveIdentityPolicy } from '../../contracts'
import { createApprovals } from '../../server/internal/approvals'
import { bootstrapRootGroup, provisionTenant, relayOutbox } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createDirectory } from '../../server/internal/directory'
import { createGovernance } from '../../server/internal/governance'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import { createServiceIdentities } from '../../server/internal/service-identities'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const MANAGE = 'identity.service-identities:manage'
const ADMIT = 'identity.service-identities:admit'

/**
 * Service identities (docs/contracts.md §23; iam-integration's service
 * identities process) against a real PostgreSQL: names, memberships only
 * where explicitly added in the owning tenant and never as an owner, the
 * lifecycle decided in the owning group, and Authentication's question
 * whether a person may manage one's credentials.
 */
describe.skipIf(!hasDatabase)('service identities on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenantId: string
  let root: string
  let rootOwner: string
  const clock: Clock = { now: () => new Date() }

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
  const policy = () => resolveIdentityPolicy({ defaultHomeTenantId: tenantId, dataRegions: ['uk'] })
  const approvals = () => createApprovals({ db, access, approvalPolicy, policy: policy(), clock })
  const governance = () => createGovernance({ db, access, policy: policy(), clock })
  const services = () => createServiceIdentities({ db, access, clock })
  const justification = { reasonCode: 'integration', reference: null }

  async function person(home = tenantId): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: home, dataRegions: ['uk'] }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function newTenant(): Promise<{ tenantId: string, root: string, owner: string }> {
    const created = await provisionTenant(operator, resolveIdentityPolicy({ dataRegions: ['uk'] }), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)
    const owner = await person(created.tenantId)
    const { groupId } = await bootstrapRootGroup(operator, { tenantId: created.tenantId, name: `Root ${uuidv7().slice(-6)}`, firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)
    return { tenantId: created.tenantId, root: groupId, owner }
  }

  async function childGroup(parent: string, owner: string): Promise<string> {
    allow(owner, 'identity.groups:create', parent)
    const { groupId } = await governance().createGroup({ subject: subject(owner), parentGroupId: parent, name: `Team ${uuidv7().slice(-8)}`, correlationId: CORRELATION_ID })
    return groupId
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    const result = await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000, clock)
    expect(result.failed).toBe(0)
    return published
  }

  async function approve(approverId: string, change: PendingChange): Promise<PendingChange> {
    return approvals().decide({ subject: subject(approverId), changeId: change.changeId, changeDigest: change.changeDigest, decision: 'approve', correlationId: CORRELATION_ID })
  }

  /** A group whose administrator (`admin`) manages its service identities, with a second person (`second`) to approve. */
  async function owningGroup(): Promise<{ groupId: string, admin: string, second: string }> {
    const groupId = await childGroup(root, rootOwner)
    const admin = await person()
    const second = await person()
    for (const permission of ['identity.service-identities:create', MANAGE]) {
      allow(admin, permission, groupId)
      qualify(second, permission, groupId)
    }
    return { groupId, admin, second }
  }

  async function createService(group: { groupId: string, admin: string, second: string }, name = `Sync ${uuidv7().slice(-6)}`): Promise<string> {
    const change = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.create', target: { groupId: group.groupId, name }, justification }, correlationId: CORRELATION_ID })
    const applied = await approve(group.second, change)
    expect(applied.state).toBe('applied')
    return applied.createdId!
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    const created = await newTenant()
    tenantId = created.tenantId
    root = created.root
    rootOwner = created.owner
  })

  beforeEach(async () => {
    allowed.clear()
    qualifying.clear()
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('names', () => {
    it('creates a named service identity, active and a member of no group, and lists it for whoever manages it', async () => {
      const group = await owningGroup()
      const identityId = await createService(group, '  Invoice   Sync ')
      const listed = await services().list({ subject: subject(group.admin), groupId: group.groupId, correlationId: CORRELATION_ID })
      expect(listed.serviceIdentities).toEqual([expect.objectContaining({ identityId, owningGroupId: group.groupId, tenantId, name: 'Invoice Sync', state: 'active', groupIds: [] })])
      expect((await events()).find(event => event.type === 'identity.provisioned' && event.data.identityId === identityId)?.data).toEqual({ identityId, kind: 'service', homeTenantId: tenantId, personalGroupId: null })
      await expect(services().list({ subject: subject(group.second), groupId: group.groupId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(services().get({ subject: subject(group.second), identityId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('refuses a name confusable with another of the group\'s, at request and on renaming', async () => {
      const group = await owningGroup()
      await createService(group, 'Nightly Export')
      await expect(approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.create', target: { groupId: group.groupId, name: 'nightly export' }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      const other = await createService(group, 'Billing')
      await expect(services().rename({ subject: subject(group.admin), identityId: other, name: 'NIGHTLY EXPORT', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      await expect(services().rename({ subject: subject(group.admin), identityId: other, name: 'Bad​name', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'validation-failed' })
    })

    it('renames without approval, announcing the change but never the name', async () => {
      const group = await owningGroup()
      const identityId = await createService(group, 'Old Name')
      await events()
      const renamed = await services().rename({ subject: subject(group.admin), identityId, name: 'New Name', correlationId: CORRELATION_ID })
      expect(renamed.name).toBe('New Name')
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['identity.renamed'])
      expect(JSON.stringify(published)).not.toContain('New Name')
      await expect(services().rename({ subject: subject(group.second), identityId, name: 'Other', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })
  })

  describe('memberships', () => {
    it('adds a service identity to a group of its tenant once someone there who does not control it approves', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      const target = await childGroup(root, rootOwner)
      const targetAdmin = await person()
      qualify(targetAdmin, ADMIT, target)
      // The requester manages the service identity in its owning group; nobody needs anything in the target group to ask.
      const change = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: target }, justification }, correlationId: CORRELATION_ID })
      expect(change).toMatchObject({ groupId: target, beneficiaryId: identityId, risk: 'high', route: 'approvers', state: 'awaiting-approval' })
      // Someone who may manage the service identity controls it, and never approves its access.
      qualify(group.second, ADMIT, target)
      await expect(approve(group.second, change)).rejects.toMatchObject({ code: 'conflict' })
      const applied = await approve(targetAdmin, change)
      expect(applied.state).toBe('applied')
      const added = (await events()).find(event => event.type === 'membership.added' && event.data.identityId === identityId)
      expect(added?.data).toMatchObject({ identityId, groupId: target, kind: 'member', owner: false })
      const actor = await createDirectory(db, clock).resolveActor(identityId, { consistency: 'strong' })
      expect(actor).toMatchObject({ identityId, kind: 'service', personalGroup: null })
      expect(actor?.memberships.map(m => m.group.groupId)).toEqual([target])
    })

    it('refuses a group in another tenant, a second membership, and a requester who does not manage it', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      const elsewhere = await newTenant()
      await expect(approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: elsewhere.root }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
      await expect(approvals().request({ subject: subject(group.second), request: { type: 'service-identity.join', target: { identityId, groupId: root }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      const target = await childGroup(root, rootOwner)
      const approver = await person()
      qualify(approver, ADMIT, target)
      await approve(approver, await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: target }, justification }, correlationId: CORRELATION_ID }))
      await expect(approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: target }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict' })
    })

    it('never lets a service identity be an owner, a guest or a member outside service-identity.join, however the row is written', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      const insert = (kind: string, owner: boolean) => seed(test.admin, [[
        `insert into identity.membership values ($1, $2, $3, $4, $5, 'active', $6, false, now(), null, null, null, null, now(), 1)`,
        [uuidv7(), identityId, root, tenantId, kind, owner],
      ]])
      await expect(insert('member', true)).rejects.toThrow('identity:service-membership')
      await expect(insert('guest', false)).rejects.toThrow('identity:service-membership')
      await expect(insert('member', false)).rejects.toThrow('identity:service-membership')
      // Joining by invitation or request needs an active person.
      allow(group.admin, 'identity.groups:view', root)
      await expect(governance().createGroup({ subject: subject(identityId), parentGroupId: root, name: 'Service Made', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('takes a service identity out of a group without approval, for whoever manages it', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      const target = await childGroup(root, rootOwner)
      const approver = await person()
      qualify(approver, ADMIT, target)
      await approve(approver, await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: target }, justification }, correlationId: CORRELATION_ID }))
      await events()
      await expect(services().leave({ subject: subject(group.second), identityId, groupId: target, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      const left = await services().leave({ subject: subject(group.admin), identityId, groupId: target, correlationId: CORRELATION_ID })
      expect(left.groupIds).toEqual([])
      expect((await events()).find(event => event.type === 'membership.ended')?.data).toMatchObject({ identityId, groupId: target, endReason: 'left' })
    })
  })

  describe('lifecycle and credentials', () => {
    it('suspends and reinstates with approval in the owning group, and answers Authentication only while active', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      const mayManage = (who: string) => services().mayManageCredentials({ subject: subject(who), identityId, correlationId: CORRELATION_ID })
      expect(await mayManage(group.admin)).toBe(true)
      expect(await mayManage(group.second)).toBe(false)
      expect(await services().mayManageCredentials({ subject: subject(group.admin), identityId: group.admin, correlationId: CORRELATION_ID })).toBe(false)
      expect(await services().mayManageCredentials({ subject: subject(group.admin), identityId: uuidv7(), correlationId: CORRELATION_ID })).toBe(false)

      const suspend = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.suspend', target: { identityId }, justification }, correlationId: CORRELATION_ID })
      expect(suspend).toMatchObject({ groupId: group.groupId, risk: 'high' })
      expect((await approve(group.second, suspend)).state).toBe('applied')
      expect((await events()).find(event => event.type === 'identity.suspended')?.data).toMatchObject({ identityId })
      expect(await mayManage(group.admin)).toBe(false)
      expect((await createProvisioning(db, policy(), clock).signInStatus(identityId))?.signIn).toBe('refused')

      const reinstate = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.reinstate', target: { identityId }, justification }, correlationId: CORRELATION_ID })
      expect((await approve(group.second, reinstate)).state).toBe('applied')
      expect((await createProvisioning(db, policy(), clock).signInStatus(identityId))?.signIn).toBe('allowed')
    })

    it('closes with approval: its memberships end, it is announced, and its name may be used again', async () => {
      const group = await owningGroup()
      const identityId = await createService(group, 'Retired Job')
      const target = await childGroup(root, rootOwner)
      const approver = await person()
      qualify(approver, ADMIT, target)
      await approve(approver, await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.join', target: { identityId, groupId: target }, justification }, correlationId: CORRELATION_ID }))
      await events()
      const close = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.close', target: { identityId }, justification }, correlationId: CORRELATION_ID })
      expect((await approve(group.second, close)).state).toBe('applied')
      const published = await events()
      expect(published.map(event => event.type)).toEqual(expect.arrayContaining(['membership.ended', 'identity.closed']))
      expect((await services().list({ subject: subject(group.admin), groupId: group.groupId, correlationId: CORRELATION_ID })).serviceIdentities).toEqual([])
      expect(await services().describe({ identityId, correlationId: CORRELATION_ID })).toBeNull()
      await createService(group, 'Retired Job')
    })

    it('names the owning group\'s active owners as the audience of its credentials, and nothing for a person', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      expect(await services().describe({ identityId, correlationId: CORRELATION_ID })).toEqual({ identityId, owningGroupId: group.groupId, ownerIds: [rootOwner] })
      expect(await services().describe({ identityId: rootOwner, correlationId: CORRELATION_ID })).toBeNull()
    })

    it('never lets a service identity request or approve a change', async () => {
      const group = await owningGroup()
      const identityId = await createService(group)
      allow(identityId, 'identity.groups:archive', group.groupId)
      await expect(approvals().request({ subject: subject(identityId), request: { type: 'group.archive', target: { groupId: group.groupId }, justification }, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })
      const change = await approvals().request({ subject: subject(group.admin), request: { type: 'service-identity.suspend', target: { identityId }, justification }, correlationId: CORRELATION_ID })
      qualify(identityId, MANAGE, group.groupId)
      await expect(approve(identityId, change)).rejects.toMatchObject({ code: 'forbidden' })
    })
  })
})
