import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConformanceFixture, ConformanceScenario } from '../../conformance'
import { identityDirectoryConformance } from '../../conformance'
import { database } from '../../server/internal/database'
import { createDirectory } from '../../server/internal/directory'
import type { TestDatabase } from '../support/database'
import { breakablePool, createTestDatabase, hasDatabase, requireDatabaseInCi } from '../support/database'
import { uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

/**
 * Identity's own directory, over PostgreSQL and the runtime role, must pass
 * the conformance suite it exports (improvement register item 1).
 */
describe.skipIf(!hasDatabase)('Identity\'s directory on PostgreSQL', async () => {
  let test: TestDatabase
  let breakable: ReturnType<typeof breakablePool>

  beforeAll(async () => {
    test = await createTestDatabase()
    breakable = breakablePool(test.runtime)
  })

  afterAll(async () => {
    await test?.drop()
  })

  const day = 86_400_000
  const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day)

  const fixture: ConformanceFixture = {
    async seed(): Promise<ConformanceScenario> {
      const sql = test.admin
      const tenantId = uuidv7()
      const parentGroupId = uuidv7()
      const groupId = uuidv7()
      await sql.query(`insert into identity.tenant values ($1, null, 'active', 'uk-gdpr', 'uk', now(), 1)`, [tenantId])
      await sql.query(`insert into identity."group" values ($1, $2, 'standard', null, 'Company', null, 'active', '{}'::jsonb, now(), 1)`, [parentGroupId, tenantId])
      await sql.query(`insert into identity."group" values ($1, $2, 'standard', $3, 'Sales', null, 'active', '{}'::jsonb, now(), 1)`, [groupId, tenantId, parentGroupId])
      const person = async (state: string) => {
        const identityId = uuidv7()
        const personalGroupId = state === 'pending' ? null : uuidv7()
        await sql.query(`insert into identity.identity values ($1, 'person', $2, null, $3, null, null, now(), now(), null, 1)`, [identityId, state, tenantId])
        if (personalGroupId) {
          await sql.query(`insert into identity."group" values ($1, $2, 'personal', null, null, null, 'active', null, now(), 1)`, [personalGroupId, tenantId])
          await sql.query(`update identity.identity set personal_group_id = $2 where identity_id = $1`, [identityId, personalGroupId])
          await sql.query(`insert into identity.membership values ($1, $2, $3, $4, 'member', 'active', true, true, now(), null, null, null, null, now(), 1)`, [uuidv7(), identityId, personalGroupId, tenantId])
        }
        return identityId
      }
      const membership = (identityId: string, kind: string, startsAt: Date, endsAt: Date | null) =>
        sql.query(`insert into identity.membership values ($1, $2, $3, $4, $5, 'active', false, false, $6, $7, null, null, null, now(), 1)`, [uuidv7(), identityId, groupId, tenantId, kind, startsAt, endsAt])
      const memberId = await person('active')
      const pausedIdentityId = await person('paused')
      const futureMemberId = await person('active')
      const lapsedMemberId = await person('active')
      const pendingIdentityId = await person('pending')
      await membership(memberId, 'member', at(-10), null)
      await membership(pausedIdentityId, 'member', at(-10), null)
      await membership(futureMemberId, 'member', at(5), null)
      await membership(lapsedMemberId, 'guest', at(-100), at(-1))
      return { memberId, groupId, parentGroupId, tenantId, pausedIdentityId, futureMemberId, lapsedMemberId, pendingIdentityId, unknownIdentityId: uuidv7(), unknownGroupId: uuidv7() }
    },
    async endMembership(identityId, groupId) {
      await test.admin.query(`update identity.membership set state = 'ended', ended_at = now(), end_reason = 'left' where identity_id = $1 and group_id = $2`, [identityId, groupId])
    },
    async breakSource() {
      breakable.break()
    },
    async restore() {
      breakable.restore()
    },
    // Identity's directory reads the source of truth every time; there is no cache to age.
    async advanceSeconds() {},
  }

  it('passes every check in the conformance suite', async () => {
    const directory = createDirectory(database({ dialect: 'postgres', pool: breakable.pool, schema: test.schema }))
    const checks = identityDirectoryConformance({ directory, fixture, boundedStalenessSeconds: 30 })
    const failures: string[] = []
    for (const check of checks) {
      try {
        await check.run()
      }
      catch (error) {
        failures.push(`${check.name}: ${error instanceof Error ? error.message : error}`)
      }
    }
    expect(failures).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(11)
  })

  it('reports a suspended identity\'s memberships as suspended, and a closed identity\'s as gone', async () => {
    const scenario = await fixture.seed()
    const directory = createDirectory(database({ dialect: 'postgres', pool: test.runtime, schema: test.schema }))
    await test.admin.query(`update identity.identity set state = 'suspended', previous_state = 'active' where identity_id = $1`, [scenario.memberId])
    const suspended = await directory.resolveActor(scenario.memberId, { consistency: 'strong' })
    expect(suspended?.memberships.map(membership => membership.effectiveStatus)).toEqual(['suspended'])
    await test.admin.query(`update identity.identity set state = 'closed', previous_state = null where identity_id = $1`, [scenario.memberId])
    expect((await directory.resolveActor(scenario.memberId, { consistency: 'strong' }))?.memberships).toEqual([])
  })
})
