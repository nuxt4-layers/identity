import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IdentityError } from '../../contracts'
import { clearIdentityComposition, provideIdentityClock, provideIdentityDatabase, provideIdentityPolicy } from '../../server/utils/identity-composition'
import { getIdentityLifecycle, getIdentityProvisioning, provisionIdentityTenant, runIdentityMaintenance } from '../../server/utils/identity-server'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const DAY = 86_400_000

/**
 * The host's clock (iam-integration's architecture §7) through Identity's
 * public server functions: every service, maintenance run and database
 * transaction takes its time from it, the database's own checks included.
 */
describe.skipIf(!hasDatabase)('the host\'s clock on PostgreSQL', () => {
  let test: TestDatabase
  let offset = 0

  beforeAll(async () => {
    test = await createTestDatabase()
    provideIdentityClock({ now: () => new Date(Date.now() + offset) })
    const { tenantId } = await provisionIdentityTenant({ pool: test.admin, jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID })
    provideIdentityDatabase({ dialect: 'postgres', pool: test.runtime })
    provideIdentityPolicy({ defaultHomeTenantId: tenantId })
  })

  afterEach(() => {
    offset = 0
  })

  afterAll(async () => {
    clearIdentityComposition()
    await test?.drop()
  })

  it('gives the database the clock\'s time for every transaction', async () => {
    offset = 40 * DAY
    const { rows } = await test.admin.query<{ at: Date }>('select identity.context_at() as at')
    // Outside Identity's transactions the database knows no clock.
    expect(Math.abs(rows[0]!.at.getTime() - Date.now())).toBeLessThan(60_000)
    const provisioning = getIdentityProvisioning()
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    const { rows: created } = await test.admin.query<{ created_at: Date }>('select created_at from identity.identity where identity_id = $1', [identityId])
    expect(created[0]!.created_at.getTime() - Date.now()).toBeGreaterThan(39 * DAY)
  })

  it('closes an identity when the clock passes the end of its grace period, and not before', async () => {
    const provisioning = getIdentityProvisioning()
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    const subject = () => ({ principalId: identityId, authenticatedAt: new Date(Date.now() + offset - 1000).toISOString(), assurance: { level: 'aal2' as const, phishingResistant: false } })
    const { closesAt } = await getIdentityLifecycle().requestClosure({ subject: subject(), correlationId: CORRELATION_ID })
    expect(Date.parse(closesAt) - Date.now()).toBeGreaterThan(29 * DAY)

    expect((await runIdentityMaintenance()).closedIdentities).toBe(0)
    offset = 31 * DAY
    expect((await runIdentityMaintenance()).closedIdentities).toBe(1)
    expect((await provisioning.signInStatus(identityId))?.signIn).toBe('refused')
  })

  it('fails closed when the clock answers no valid time', async () => {
    provideIdentityClock({ now: () => new Date(Number.NaN) })
    await expect(runIdentityMaintenance()).rejects.toEqual(expect.objectContaining({ code: 'unavailable' }))
    await expect(getIdentityProvisioning().reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })).rejects.toBeInstanceOf(IdentityError)
    provideIdentityClock({ now: () => new Date(Date.now() + offset) })
  })
})
