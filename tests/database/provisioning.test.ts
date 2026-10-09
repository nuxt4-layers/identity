import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IdentityEvent } from '../../contracts'
import { IdentityError, identityEventSchema, resolveIdentityPolicy } from '../../contracts'
import { provisionTenant, relayOutbox, runMaintenance } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { createDirectory } from '../../server/internal/directory'
import type { Clock } from '../../server/internal/provisioning'
import { createProvisioning } from '../../server/internal/provisioning'
import type { TestDatabase } from '../support/database'
import { breakablePool, createTestDatabase, hasDatabase, requireDatabaseInCi } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

describe.skipIf(!hasDatabase)('provisioning, outbox and maintenance on PostgreSQL', () => {
  let test: TestDatabase
  let db: Database
  let operator: Database
  let tenantId: string
  let now = new Date('2026-10-09T12:00:00.000Z')
  const clock: Clock = { now: () => now }
  const policy = () => resolveIdentityPolicy({ defaultHomeTenantId: tenantId })
  const provisioning = () => createProvisioning(db, policy(), clock)

  async function drain(): Promise<IdentityEvent[]> {
    const events: IdentityEvent[] = []
    await relayOutbox(db, { publish: async (event) => { events.push(event) } }, 1000, clock)
    return events
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    tenantId = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).tenantId
  })

  afterAll(async () => {
    await test?.drop()
  })

  it('provisions a tenant only in a registered jurisdiction and region, and announces it', async () => {
    await expect(provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'us-ccpa', dataRegion: 'uk', correlationId: CORRELATION_ID }, clock)).rejects.toMatchObject({ code: 'validation-failed' })
    const events = await drain()
    expect(events.map(event => event.type)).toEqual(['tenant.created'])
    expect(events[0]!.data).toEqual({ tenantId, jurisdiction: 'uk-gdpr', dataRegion: 'uk' })
  })

  it('reserves a pending identity, idempotently by request, with no personal data and no event', async () => {
    const requestId = uuidv7()
    const first = await provisioning().reserve({ requestId, kind: 'person', correlationId: CORRELATION_ID })
    const again = await provisioning().reserve({ requestId, kind: 'person', correlationId: CORRELATION_ID })
    expect(again).toEqual(first)
    expect(first).toEqual({ identityId: expect.any(String), state: 'pending', expiresAt: '2026-10-10T12:00:00.000Z' })
    expect(await drain()).toEqual([])
    expect(await provisioning().signInStatus(first.identityId)).toMatchObject({ state: 'pending', signIn: 'verification-only', passkeyOnly: false })
    expect(await createDirectory(db, clock).resolveActor(first.identityId, { consistency: 'strong' })).toBeNull()
  })

  it('reserves concurrently for one request without creating two identities', async () => {
    const requestId = uuidv7()
    const results = await Promise.all(Array.from({ length: 5 }, () => provisioning().reserve({ requestId, kind: 'person', correlationId: CORRELATION_ID })))
    expect(new Set(results.map(result => result.identityId)).size).toBe(1)
    const { rows } = await test.admin.query('select count(*)::int as n from identity.provisioning_request where request_id = $1', [requestId])
    expect(rows[0].n).toBe(1)
  })

  it('refuses an unknown or missing home tenant', async () => {
    await expect(provisioning().reserve({ requestId: uuidv7(), kind: 'person', homeTenantId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'validation-failed' })
    await expect(createProvisioning(db, resolveIdentityPolicy(), clock).reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })).rejects.toBeInstanceOf(IdentityError)
  })

  it('confirms atomically: one personal group, one permanent membership, active, one event', async () => {
    const { identityId } = await provisioning().reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    const confirmed = await provisioning().confirm({ identityId, correlationId: CORRELATION_ID })
    expect(confirmed).toEqual({ identityId, state: 'active', personalGroupId: expect.any(String), homeTenantId: tenantId })
    expect(await provisioning().confirm({ identityId, correlationId: CORRELATION_ID })).toEqual(confirmed)
    const groups = await test.admin.query(`select kind, tenant_id, name, parent_group_id from identity."group" where group_id = $1`, [confirmed.personalGroupId])
    expect(groups.rows).toEqual([{ kind: 'personal', tenant_id: tenantId, name: null, parent_group_id: null }])
    const memberships = await test.admin.query('select count(*)::int as n from identity.membership where identity_id = $1', [identityId])
    expect(memberships.rows[0].n).toBe(1)
    const events = await drain()
    expect(events.map(event => event.type)).toEqual(['identity.provisioned'])
    expect(events[0]).toMatchObject({ correlationId: CORRELATION_ID, aggregate: { type: 'identity', id: identityId, version: 2 }, data: { identityId, kind: 'person', homeTenantId: tenantId, personalGroupId: confirmed.personalGroupId } })
    expect(await provisioning().signInStatus(identityId)).toMatchObject({ state: 'active', signIn: 'allowed' })
    const actor = await createDirectory(db, clock).resolveActor(identityId, { consistency: 'strong' })
    expect(actor).toMatchObject({ identityState: 'active', personalGroup: { groupId: confirmed.personalGroupId, kind: 'personal', lineage: [confirmed.personalGroupId] }, memberships: [] })
  })

  it('expires an unconfirmed identity after its window, announces it, and never confirms it afterwards', async () => {
    const { identityId } = await provisioning().reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await drain()
    now = new Date(now.getTime() + 25 * 3_600_000)
    await expect(provisioning().confirm({ identityId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
    expect((await runMaintenance(db, clock)).expiredPendingIdentities).toBeGreaterThanOrEqual(1)
    expect((await runMaintenance(db, clock)).expiredPendingIdentities).toBe(0)
    const events = await drain()
    expect(events.filter(event => event.type === 'identity.provisioning-expired').map(event => event.data)).toContainEqual({ identityId })
    expect(await provisioning().signInStatus(identityId)).toMatchObject({ state: 'closed', signIn: 'refused' })
    await expect(provisioning().confirm({ identityId, correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('answers null for unknown identities and refuses to confirm them, revealing nothing', async () => {
    expect(await provisioning().signInStatus(uuidv7())).toBeNull()
    expect(await provisioning().signInStatus('not-an-id')).toBeNull()
    await expect(provisioning().confirm({ identityId: uuidv7(), correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('publishes each event once, in order, valid against the contract, and keeps failed ones for the next run', async () => {
    for (let index = 0; index < 3; index++) {
      const { identityId } = await provisioning().reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
      await provisioning().confirm({ identityId, correlationId: CORRELATION_ID })
    }
    let calls = 0
    const failing = { publish: vi.fn(async () => { if (++calls === 2) throw new Error('broker down') }) }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await relayOutbox(db, failing, 100, clock)).toEqual({ published: 1, failed: 1 })
    error.mockRestore()
    const rest = await drain()
    expect(rest).toHaveLength(2)
    for (const event of rest) expect(identityEventSchema.safeParse(event).success).toBe(true)
    expect(await drain()).toEqual([])
  })

  it('never publishes an event twice when relays run concurrently', async () => {
    for (let index = 0; index < 6; index++) {
      const { identityId } = await provisioning().reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
      await provisioning().confirm({ identityId, correlationId: CORRELATION_ID })
    }
    const seen: string[] = []
    const publisher = { publish: async (event: IdentityEvent) => { seen.push(event.eventId); await new Promise(resolve => setTimeout(resolve, 5)) } }
    await Promise.all([relayOutbox(db, publisher, 100, clock), relayOutbox(db, publisher, 100, clock), relayOutbox(db, publisher, 100, clock)])
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('fails closed with `unavailable` when the database is unreachable', async () => {
    const breakable = breakablePool(test.runtime)
    const broken = database({ dialect: 'postgres', pool: breakable.pool, schema: test.schema })
    breakable.break()
    await expect(createProvisioning(broken, policy(), clock).reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(createProvisioning(broken, policy(), clock).signInStatus(uuidv7())).rejects.toMatchObject({ code: 'unavailable' })
  })
})
