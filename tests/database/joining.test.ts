import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityEvent, IdentityPolicyInput, IdentitySubject } from '../../contracts'
import { INVITATION_ACKNOWLEDGEMENT, resolveIdentityPolicy } from '../../contracts'
import { bootstrapRootGroup, provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createGovernance } from '../../server/internal/governance'
import { createJoining } from '../../server/internal/joining'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning, invitationTokenDigest } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const DAY = 86_400_000

describe.skipIf(!hasDatabase)('invitations and join requests on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenant: string
  let otherTenant: string
  let root: string
  let offset = 0
  const clock: Clock = { now: () => new Date(Date.now() + offset) }

  const allowed = new Set<string>()
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)
  const subject = (principalId: string): IdentitySubject =>
    ({ principalId, authenticatedAt: clock.now().toISOString(), assurance: { level: 'aal2', phishingResistant: true } })
  const joining = (policy: IdentityPolicyInput = {}) => createJoining({ db, access, policy: resolveIdentityPolicy(policy), clock })
  const ack = INVITATION_ACKNOWLEDGEMENT

  async function person(tenantId = tenant): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenantId }), clock)
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  /** A child group of the root, with a fresh owner who may manage invitations and decide join requests. */
  async function group(settings: Record<string, unknown> = {}): Promise<{ groupId: string, admin: string }> {
    const admin = await person()
    allow(admin, 'identity.groups:create', root)
    const { groupId } = await createGovernance({ db, access, policy: resolveIdentityPolicy(), clock })
      .createGroup({ subject: subject(admin), parentGroupId: root, name: `Team ${uuidv7().slice(-8)}`, correlationId: CORRELATION_ID })
    for (const [path, value] of Object.entries(settings)) {
      await seed(test.admin, [[`update identity."group" set settings = jsonb_set(settings, $2::text[], $3::jsonb) where group_id = $1`, [groupId, path.split('.'), JSON.stringify(value)]]])
    }
    allow(admin, 'identity.invitations:manage', groupId)
    allow(admin, 'identity.join-requests:decide', groupId)
    return { groupId, admin }
  }

  async function membership(identityId: string, groupId: string): Promise<{ kind: string, state: string, ends_at: Date | null } | undefined> {
    const { rows } = await test.admin.query(`select kind, state, ends_at from identity.membership where identity_id = $1 and group_id = $2 and state <> 'ended'`, [identityId, groupId])
    return rows[0]
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
    otherTenant = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
    root = (await bootstrapRootGroup(operator, { tenantId: tenant, name: 'Company', firstOwnerId: await person(), correlationId: CORRELATION_ID }, clock)).groupId
  })

  beforeEach(async () => {
    allowed.clear()
    offset = 0
    await events()
  })

  afterAll(async () => {
    await test?.drop()
  })

  describe('invitations', () => {
    it('stores only the token\'s digest, admits the holder at once, and is single use', async () => {
      const { groupId, admin } = await group()
      const invitee = await person()
      const later = await person()
      const { token, invitationId, requiresConfirmation } = await joining().invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(requiresConfirmation).toBe(false)
      const { rows } = await test.admin.query(`select to_jsonb(i)::text as row from identity.invitation i where invitation_id = $1`, [invitationId])
      expect(rows[0].row).not.toContain(token)
      expect(rows[0].row).toContain(invitationTokenDigest(token))
      await events()

      expect(await joining().accept({ subject: subject(invitee), token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(invitee, groupId)).toMatchObject({ kind: 'member', state: 'active', ends_at: null })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['membership.added', 'invitation.accepted'])
      expect(published[1]).toMatchObject({ actorId: invitee, data: { invitationId, groupId, invitedBy: admin, acceptedBy: invitee, awaitingConfirmation: false } })

      expect(await joining().accept({ subject: subject(later), token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(later, groupId)).toBeUndefined()
      expect(await events()).toEqual([])
    })

    it('answers every acceptance alike, so tokens, groups and identities cannot be probed', async () => {
      const { groupId, admin } = await group()
      const someone = await person()
      const other = await person()
      const bound = await joining().invite({ subject: subject(admin), groupId, kind: 'member', inviteeIdentityId: other, correlationId: CORRELATION_ID })
      const revoked = await joining().invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      await joining().revoke({ subject: subject(admin), invitationId: revoked.invitationId, correlationId: CORRELATION_ID })
      const own = await joining().invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      await events()
      for (const token of ['A'.repeat(43), bound.token, revoked.token]) {
        expect(await joining().accept({ subject: subject(someone), token, correlationId: CORRELATION_ID })).toEqual(ack)
      }
      // The inviter cannot admit themselves with their own invitation.
      expect(await joining().accept({ subject: subject(admin), token: own.token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await events()).toEqual([])
      expect(await membership(someone, groupId)).toBeUndefined()
      await expect(joining().accept({ subject: subject(someone), token: 'short', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'validation-failed' })

      // A bound invitation admits only its invitee, without confirmation even for a guest.
      expect(await joining().accept({ subject: subject(other), token: bound.token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(other, groupId)).toMatchObject({ kind: 'member' })
      const guest = await joining().invite({ subject: subject(admin), groupId, kind: 'guest', inviteeIdentityId: someone, correlationId: CORRELATION_ID })
      expect(guest.requiresConfirmation).toBe(false)
    })

    it('makes a guest\'s acceptance of a forwarded link wait for an administrator, who is never the person who accepted', async () => {
      const { groupId, admin } = await group()
      const holder = await person()
      const second = await person()
      allow(holder, 'identity.invitations:manage', groupId)
      const invitation = await joining().invite({ subject: subject(admin), groupId, kind: 'guest', correlationId: CORRELATION_ID })
      expect(invitation.requiresConfirmation).toBe(true)
      await events()
      await joining().accept({ subject: subject(holder), token: invitation.token, correlationId: CORRELATION_ID })
      expect(await membership(holder, groupId)).toBeUndefined()
      expect((await events()).map(event => [event.type, event.data])).toEqual([['invitation.accepted', {
        invitationId: invitation.invitationId, groupId, invitedBy: admin, acceptedBy: holder, awaitingConfirmation: true,
      }]])
      await expect(joining().decideAcceptance({ subject: subject(holder), invitationId: invitation.invitationId, decision: 'confirm', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'own-acceptance' })
      await expect(joining().decideAcceptance({ subject: subject(second), invitationId: invitation.invitationId, decision: 'confirm', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'forbidden' })

      const confirmed = await joining().decideAcceptance({ subject: subject(admin), invitationId: invitation.invitationId, decision: 'confirm', correlationId: CORRELATION_ID })
      expect(confirmed).toMatchObject({ state: 'accepted', acceptedBy: holder, confirmedBy: admin })
      const guest = await membership(holder, groupId)
      expect(guest).toMatchObject({ kind: 'guest', state: 'active' })
      expect(guest!.ends_at!.getTime() - Date.now()).toBeGreaterThan(89 * DAY)
      expect((await events()).map(event => [event.type, event.actorId])).toEqual([['membership.added', admin]])

      // Refused instead: no membership, and the refusal is announced.
      const refusedInvitation = await joining().invite({ subject: subject(admin), groupId, kind: 'guest', correlationId: CORRELATION_ID })
      await joining().accept({ subject: subject(second), token: refusedInvitation.token, correlationId: CORRELATION_ID })
      await events()
      expect(await joining().decideAcceptance({ subject: subject(admin), invitationId: refusedInvitation.invitationId, decision: 'refuse', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'refused', confirmedBy: admin })
      expect(await membership(second, groupId)).toBeUndefined()
      expect((await events()).map(event => [event.type, event.data])).toEqual([['invitation.refused', { invitationId: refusedInvitation.invitationId, groupId, refusedBy: admin }]])
      expect((await joining().listInvitations({ subject: subject(admin), groupId, correlationId: CORRELATION_ID })).map(i => i.state)).toEqual(['refused', 'accepted'])
    })

    it('refuses an unknown or unauthorised group alike, guests where the group allows none, and a self-invitation', async () => {
      const { groupId, admin } = await group({ 'guests.allowed': false })
      const stranger = await person()
      await expect(joining().invite({ subject: subject(stranger), groupId, kind: 'member', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(joining().invite({ subject: subject(admin), groupId: uuidv7(), kind: 'member', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(joining().invite({ subject: subject(admin), groupId, kind: 'guest', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      await expect(joining().invite({ subject: subject(admin), groupId, kind: 'member', inviteeIdentityId: admin, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      await expect(joining().invite({ subject: subject(admin), groupId, kind: 'member', inviteeIdentityId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('limits invitations per inviter and acceptance attempts per identity', async () => {
      const { groupId, admin } = await group()
      const limited = joining({ invitationsPerInviterPerHour: 2, acceptanceAttemptsPerHour: 2 })
      await limited.invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      const { token } = await limited.invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      await expect(limited.invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'rate-limited' })
      const guesser = await person()
      await limited.accept({ subject: subject(guesser), token: 'B'.repeat(43), correlationId: CORRELATION_ID })
      await limited.decline({ subject: subject(guesser), token: 'C'.repeat(43), correlationId: CORRELATION_ID })
      await expect(limited.accept({ subject: subject(guesser), token, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'rate-limited' })
      expect(await membership(guesser, groupId)).toBeUndefined()
      offset = 2 * 3_600_000
      expect(await limited.accept({ subject: subject(guesser), token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(guesser, groupId)).toMatchObject({ state: 'active' })
    })

    it('expires unused invitations and unconfirmed acceptances', async () => {
      const { groupId, admin } = await group()
      const holder = await person()
      const unused = await joining().invite({ subject: subject(admin), groupId, kind: 'member', correlationId: CORRELATION_ID })
      const waiting = await joining().invite({ subject: subject(admin), groupId, kind: 'guest', correlationId: CORRELATION_ID })
      await joining().accept({ subject: subject(holder), token: waiting.token, correlationId: CORRELATION_ID })
      offset = 8 * DAY
      expect(await joining().decideAcceptance({ subject: subject(admin), invitationId: waiting.invitationId, decision: 'confirm', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'expired' })
      offset = 15 * DAY
      expect((await runMaintenance(db, clock)).expiredInvitations).toBeGreaterThanOrEqual(1)
      expect(await joining().accept({ subject: subject(holder), token: unused.token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(holder, groupId)).toBeUndefined()
    })

    it('makes the inviting tenant the home tenant of someone who signs up with an unbound invitation', async () => {
      const owner = await person(otherTenant)
      const otherRoot = (await bootstrapRootGroup(operator, { tenantId: otherTenant, name: 'Other', firstOwnerId: owner, correlationId: CORRELATION_ID }, clock)).groupId
      allow(owner, 'identity.invitations:manage', otherRoot)
      const { token } = await joining().invite({ subject: subject(owner), groupId: otherRoot, kind: 'member', correlationId: CORRELATION_ID })
      const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenant }), clock)
      const reserved = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', invitationToken: token, correlationId: CORRELATION_ID })
      expect((await provisioning.confirm({ identityId: reserved.identityId, correlationId: CORRELATION_ID })).homeTenantId).toBe(otherTenant)
      // An unusable token falls back to the default, revealing nothing.
      const fallback = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', invitationToken: 'D'.repeat(43), correlationId: CORRELATION_ID })
      expect((await provisioning.confirm({ identityId: fallback.identityId, correlationId: CORRELATION_ID })).homeTenantId).toBe(tenant)
      await expect(provisioning.reserve({ requestId: uuidv7(), kind: 'person', invitationToken: token, homeTenantId: tenant, correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'validation-failed' })
      // Reserving does not use the invitation up.
      expect(await joining().accept({ subject: subject(reserved.identityId), token, correlationId: CORRELATION_ID })).toEqual(ack)
      expect(await membership(reserved.identityId, otherRoot)).toMatchObject({ state: 'active' })
    })
  })

  describe('join requests', () => {
    it('records a request from someone in the tenant, which an administrator approves', async () => {
      const { groupId, admin } = await group()
      const asker = await person()
      await events()
      const first = await joining().requestToJoin({ subject: subject(asker), groupId, correlationId: CORRELATION_ID })
      expect(first.outcome).toBe('requested')
      expect(await joining().requestToJoin({ subject: subject(asker), groupId, correlationId: CORRELATION_ID })).toEqual(first)
      expect((await events()).map(event => [event.type, event.data])).toEqual([['join-request.created', { joinRequestId: first.joinRequestId, groupId, identityId: asker }]])
      allow(asker, 'identity.join-requests:decide', groupId)
      await expect(joining().decideJoinRequest({ subject: subject(asker), joinRequestId: first.joinRequestId!, decision: 'approve', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'own-request' })
      expect((await joining().listJoinRequests({ subject: subject(admin), groupId, correlationId: CORRELATION_ID })).map(r => r.identityId)).toEqual([asker])

      expect(await joining().decideJoinRequest({ subject: subject(admin), joinRequestId: first.joinRequestId!, decision: 'approve', correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'approved', decidedBy: admin })
      expect(await membership(asker, groupId)).toMatchObject({ kind: 'member', state: 'active' })
      const published = await events()
      expect(published.map(event => event.type)).toEqual(['membership.added', 'join-request.decided'])
      expect(published[1]).toMatchObject({ actorId: admin, data: { outcome: 'approved' } })
      await expect(joining().requestToJoin({ subject: subject(asker), groupId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
    })

    it('admits at once where joining is open, refuses where it is closed, and hides groups in other tenants', async () => {
      const open = await group({ 'joining.open': true })
      const closed = await group({ 'joining.requests': false })
      const asker = await person()
      const outsider = await person(otherTenant)
      expect(await joining().requestToJoin({ subject: subject(asker), groupId: open.groupId, correlationId: CORRELATION_ID })).toEqual({ outcome: 'joined', joinRequestId: null })
      expect(await membership(asker, open.groupId)).toMatchObject({ state: 'active' })
      await expect(joining().requestToJoin({ subject: subject(asker), groupId: closed.groupId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
      await expect(joining().requestToJoin({ subject: subject(outsider), groupId: open.groupId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(joining().requestToJoin({ subject: subject(outsider), groupId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
    })

    it('lets the person withdraw, and expires requests nobody decides', async () => {
      const { groupId, admin } = await group()
      const withdrawing = await person()
      const waiting = await person()
      const withdrawn = await joining().requestToJoin({ subject: subject(withdrawing), groupId, correlationId: CORRELATION_ID })
      await expect(joining().withdrawJoinRequest({ subject: subject(admin), joinRequestId: withdrawn.joinRequestId!, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
      expect(await joining().withdrawJoinRequest({ subject: subject(withdrawing), joinRequestId: withdrawn.joinRequestId!, correlationId: CORRELATION_ID }))
        .toMatchObject({ state: 'withdrawn', decidedBy: null })
      const expiring = await joining().requestToJoin({ subject: subject(waiting), groupId, correlationId: CORRELATION_ID })
      await events()
      offset = 8 * DAY
      expect((await runMaintenance(db, clock)).expiredJoinRequests).toBeGreaterThanOrEqual(1)
      expect((await events()).filter(event => event.aggregate.id === expiring.joinRequestId).map(event => (event.data as { outcome: string }).outcome)).toEqual(['expired'])
      await expect(joining().decideJoinRequest({ subject: subject(admin), joinRequestId: expiring.joinRequestId!, decision: 'approve', correlationId: CORRELATION_ID }))
        .rejects.toMatchObject({ code: 'conflict', message: 'not-open' })
    })
  })

  it('never lets the runtime role write invitations, join requests or acceptance attempts directly', async () => {
    const { groupId, admin } = await group()
    const context = { tenantIds: [tenant], actorId: admin, correlationId: CORRELATION_ID }
    await expect(db.transaction(client => client.query(`update identity.invitation set state = 'accepted' where group_id = $1`, [groupId]), context)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(db.transaction(client => client.query(`delete from identity.join_request`), context)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(db.transaction(client => client.query(`select * from identity.acceptance_attempt`), context)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
