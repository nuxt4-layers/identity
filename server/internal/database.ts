import type { IdentityDatabase } from '../../contracts'
import { IdentityError } from '../../contracts'
import { quoteIdentifier } from '../database/migrations'

/** PRIVATE. Transactions and error translation over the host-supplied pool. */

export interface QueryClient {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>
}

interface PoolClientLike extends QueryClient {
  release(): void
}

export interface Database {
  /** The quoted schema, for building SQL. */
  schema: string
  /**
   * Runs `work` in one transaction. `tenantIds` sets the transaction-local
   * `identity.tenant_ids` that row-level security reads; with none, the
   * runtime role sees no tenant-isolated rows.
   */
  transaction<T>(work: (client: QueryClient) => Promise<T>, tenantIds?: readonly string[]): Promise<T>
}

const DOMAIN_ERRORS: Readonly<Record<string, IdentityError['code']>> = {
  'identity:tenant-unavailable': 'validation-failed',
  'identity:unknown': 'forbidden',
  'identity:not-pending': 'conflict',
  'identity:expired': 'conflict',
}

/** Maps a database error to a contract error. Unknown failures are `unavailable` and fail closed. */
export function translateError(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error
  const message = error instanceof Error ? error.message : ''
  const code = DOMAIN_ERRORS[message]
  return code ? new IdentityError(code, message) : new IdentityError('unavailable', message || 'identity database failure')
}

export function database(port: IdentityDatabase & { schema: string }): Database {
  const schema = quoteIdentifier(port.schema, 'schema')
  return {
    schema,
    async transaction(work, tenantIds = []) {
      let client: PoolClientLike
      try {
        client = await port.pool.connect() as PoolClientLike
      }
      catch (error) {
        throw translateError(error)
      }
      try {
        await client.query('begin')
        await client.query(`select set_config('identity.tenant_ids', $1, true)`, [`{${tenantIds.join(',')}}`])
        const result = await work(client)
        await client.query('commit')
        return result
      }
      catch (error) {
        await client.query('rollback').catch(() => {})
        throw translateError(error)
      }
      finally {
        client.release()
      }
    },
  }
}
