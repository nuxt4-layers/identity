import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { runIdentityMigrations } from '../../server/database/migrations'

/**
 * Disposable PostgreSQL databases for database tests (ADR-0002: never a
 * shared hosted database). Set IDENTITY_TEST_DATABASE_URL to an admin
 * connection, e.g. postgres://postgres:postgres@localhost:5432/postgres.
 */
export const adminUrl = process.env.IDENTITY_TEST_DATABASE_URL

/** True when database suites can run. In CI the URL is mandatory. */
export const hasDatabase = Boolean(adminUrl)

/** Registers a test that fails in CI when the database is not configured, so suites cannot be skipped silently. */
export function requireDatabaseInCi(): void {
  it('has a test database configured when running in CI', () => {
    if (process.env.CI) expect(adminUrl, 'IDENTITY_TEST_DATABASE_URL must be set in CI').toBeTruthy()
  })
}

export interface TestDatabase {
  /** The migration (owner) role's pool: seeds fixtures and inspects state. */
  admin: pg.Pool
  /** The runtime role's pool: what the layer uses, under row-level security. */
  runtime: pg.Pool
  runtimeRole: string
  schema: string
  drop(): Promise<void>
}

/**
 * A fresh database with Identity's migrations applied, and a runtime role
 * that owns nothing and cannot bypass row-level security.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const suffix = randomBytes(6).toString('hex')
  const name = `identity_test_${suffix}`
  const runtimeRole = `identity_runtime_${suffix}`
  const password = randomBytes(12).toString('hex')
  const root = new pg.Client({ connectionString: adminUrl })
  await root.connect()
  await root.query(`create database "${name}"`)
  await root.query(`create role "${runtimeRole}" login password '${password}' nosuperuser nobypassrls`)
  await root.end()

  const adminTarget = new URL(adminUrl!)
  adminTarget.pathname = `/${name}`
  const runtimeTarget = new URL(adminTarget)
  runtimeTarget.username = runtimeRole
  runtimeTarget.password = password

  const admin = new pg.Pool({ connectionString: adminTarget.toString(), max: 4 })
  await runIdentityMigrations(admin, 'identity', runtimeRole)
  const runtime = new pg.Pool({ connectionString: runtimeTarget.toString(), max: 4 })
  // An idle connection closed by the server while the database is dropped is expected, not a test failure.
  for (const pool of [admin, runtime]) pool.on('error', () => {})

  return {
    admin,
    runtime,
    runtimeRole,
    schema: 'identity',
    async drop() {
      await runtime.end()
      await admin.end()
      const client = new pg.Client({ connectionString: adminUrl })
      await client.connect()
      await client.query(`drop database if exists "${name}" with (force)`)
      await client.query(`drop role if exists "${runtimeRole}"`)
      await client.end()
    },
  }
}

/** A pool wrapper whose connections fail on demand, to show the layer fails closed. */
export function breakablePool(pool: pg.Pool) {
  let broken = false
  return {
    pool: {
      query: (text: string, values?: readonly unknown[]) => (broken ? Promise.reject(new Error('connection lost')) : pool.query(text, values as unknown[])),
      connect: () => (broken ? Promise.reject(new Error('connection lost')) : pool.connect()),
      end: () => Promise.resolve(),
    },
    break() { broken = true },
    restore() { broken = false },
  }
}

/**
 * Runs fixture statements as the migration role in one transaction, with the
 * request context the triggers require (a correlation identifier and an
 * actor), as the layer's own transactions set it.
 */
export async function seed(pool: pg.Pool, statements: ReadonlyArray<[string, unknown[]?]>, actorId: string = '01a120c9-2cd1-784a-a3d6-f725b2cb2eab'): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query(`select set_config('identity.correlation_id', $1, true), set_config('identity.actor_id', $2, true)`, ['01a120c9-2cd1-784a-a3d6-f725b2cb2eac', actorId])
    for (const [text, values] of statements) await client.query(text, values as unknown[])
    await client.query('commit')
  }
  catch (error) {
    await client.query('rollback')
    throw error
  }
  finally {
    client.release()
  }
}

