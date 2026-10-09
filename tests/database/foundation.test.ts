import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IDENTITY_MIGRATIONS, runIdentityMigrations } from '../../server/database/migrations'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

describe.skipIf(!hasDatabase)('identity schema, roles and row-level security', () => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await createTestDatabase()
  })

  afterAll(async () => {
    await db?.drop()
  })

  it('applies every migration once, even when instances race', async () => {
    const again = await Promise.all([
      runIdentityMigrations(db.admin, 'identity', db.runtimeRole),
      runIdentityMigrations(db.admin, 'identity', db.runtimeRole),
    ])
    expect(again.flat()).toEqual([])
    const { rows } = await db.admin.query('select id from identity.schema_migration order by id')
    expect(rows.map(row => row.id)).toEqual(IDENTITY_MIGRATIONS.map(migration => migration.id))
  })

  it('creates every table inside the capability-owned schema only', async () => {
    const { rows } = await db.admin.query(`select table_schema, table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by table_name`)
    expect(rows.every(row => row.table_schema === 'identity')).toBe(true)
    expect(rows.map(row => row.table_name)).toEqual(['acceptance_attempt', 'break_glass_review', 'founding_claim', 'group', 'identity', 'identity_external_id', 'invitation', 'join_request', 'membership', 'outbox', 'pending_change', 'provisioning_request', 'schema_migration', 'tenant'])
  })

  it('refuses a runtime role that could bypass row-level security, or the migration role itself', async () => {
    await db.admin.query(`create role identity_bypass_${db.runtimeRole.slice(-6)} bypassrls`)
    await expect(runIdentityMigrations(db.admin, 'identity', `identity_bypass_${db.runtimeRole.slice(-6)}`)).rejects.toThrow(/bypass row-level security/)
    await db.admin.query(`drop role identity_bypass_${db.runtimeRole.slice(-6)}`)
    const { rows } = await db.admin.query('select current_user as me')
    await expect(runIdentityMigrations(db.admin, 'identity', rows[0].me)).rejects.toThrow(/must not/)
  })

  it('gives the runtime role no table it owns, and no direct access to cross-tenant tables', async () => {
    const owned = await db.admin.query('select count(*)::int as n from pg_tables where schemaname = $1 and tableowner = $2', ['identity', db.runtimeRole])
    expect(owned.rows[0].n).toBe(0)
    for (const table of ['identity', 'outbox', 'provisioning_request', 'schema_migration']) {
      await expect(db.runtime.query(`select * from identity.${table} limit 1`), table).rejects.toThrow(/permission denied/)
    }
    await expect(db.runtime.query(`insert into identity.tenant values ($1, null, 'active', 'uk-gdpr', 'uk', now(), 1)`, [uuidv7()])).rejects.toThrow(/permission denied/)
  })

  it('shows the runtime role only the tenants set for the transaction, and nothing without a setting', async () => {
    const a = uuidv7()
    const b = uuidv7()
    for (const tenant of [a, b]) {
      await seed(db.admin, [
        [`insert into identity.tenant values ($1, null, 'active', 'uk-gdpr', 'uk', now(), 1)`, [tenant]],
        [`insert into identity."group" values ($1, $2, 'standard', null, 'Team', null, 'active', '{}'::jsonb, now(), 1, 'team')`, [uuidv7(), tenant]],
      ])
    }
    const read = async (tenants: string[] | null) => {
      const client = await db.runtime.connect()
      try {
        await client.query('begin')
        if (tenants) await client.query(`select set_config('identity.tenant_ids', $1, true)`, [`{${tenants.join(',')}}`])
        const groups = await client.query('select tenant_id from identity."group"')
        const tenantRows = await client.query('select tenant_id from identity.tenant')
        await client.query('commit')
        return { groups: groups.rows.map(row => row.tenant_id), tenants: tenantRows.rows.map(row => row.tenant_id) }
      }
      finally {
        client.release()
      }
    }
    expect(await read(null)).toEqual({ groups: [], tenants: [] })
    expect(await read([a])).toEqual({ groups: [a], tenants: [a] })
    expect((await read([a, b])).groups.sort()).toEqual([a, b].sort())
  })

  it('does not carry a tenant setting to the next transaction on a pooled connection', async () => {
    const client = await db.runtime.connect()
    try {
      await client.query('begin')
      await client.query(`select set_config('identity.tenant_ids', $1, true)`, [`{${uuidv7()}}`])
      await client.query('commit')
      const { rows } = await client.query(`select identity.current_tenant_ids() as ids`)
      expect(rows[0].ids).toEqual([])
    }
    finally {
      client.release()
    }
  })

  it('lets the runtime role call only the port functions, never the internal ones', async () => {
    await expect(db.runtime.query(`select identity.enqueue_event('identity.paused', null, 'identity', $1, 1, null, $1, now(), '{}'::jsonb)`, [uuidv7()])).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`select identity.lineage_of($1)`, [uuidv7()])).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`select identity.describe_group($1) as g`, [uuidv7()])).resolves.toBeDefined()
  })

  it('never lets the runtime role create tenants, write pending changes or apply a change itself', async () => {
    const id = uuidv7()
    await expect(db.runtime.query(`select identity.create_tenant('uk-gdpr', 'uk', null, $1, now())`, [id])).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`select identity.settle_change($1, now(), null)`, [id])).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`select identity.close_change($1, 'cancelled', null, now())`, [id])).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`update identity.pending_change set state = 'applied'`)).rejects.toThrow(/permission denied/)
    await expect(db.runtime.query(`delete from identity.pending_change`)).rejects.toThrow(/permission denied/)
  })

  it('fixes the search path of every SECURITY DEFINER function', async () => {
    const { rows } = await db.admin.query(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'identity' and p.prosecdef`)
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, pg_temp'])
  })
})
