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
   * Runs `work` in one transaction with a transaction-local context:
   * `tenantIds` for row-level security (with none, the runtime role sees no
   * tenant-isolated rows), and the actor, correlation identifier and time
   * that triggers write into events.
   */
  transaction<T>(work: (client: QueryClient) => Promise<T>, context?: TransactionContext): Promise<T>
}

export interface TransactionContext {
  tenantIds?: readonly string[]
  actorId?: string | null
  correlationId?: string
  at?: Date
}

const DOMAIN_ERRORS: Readonly<Record<string, IdentityError['code']>> = {
  'identity:tenant-unavailable': 'validation-failed',
  'identity:hierarchy-tenant': 'conflict',
  'identity:hierarchy-parent': 'conflict',
  'identity:hierarchy-cycle': 'conflict',
  'identity:hierarchy-depth': 'conflict',
  'identity:requires-approval': 'forbidden',
  'identity:unknown': 'forbidden',
  'identity:not-pending': 'conflict',
  'identity:expired': 'conflict',
  // Governance approvals (phase 3a)
  'identity:approval-refused': 'forbidden',
  'identity:unknown-change': 'validation-failed',
  'identity:justification-missing': 'validation-failed',
  'identity:self-grant': 'conflict',
  'identity:approval-floor': 'conflict',
  'identity:change-differs': 'conflict',
  'identity:changed-since-request': 'conflict',
  'identity:owner-unavailable': 'conflict',
  'identity:group-not-active': 'conflict',
  'identity:active-children': 'conflict',
  'identity:active-service-identities': 'conflict',
  'identity:already-owner': 'conflict',
  'identity:not-eligible': 'conflict',
  'identity:not-owner': 'conflict',
  'identity:last-owner': 'conflict',
  'identity:already-suspended': 'conflict',
  'identity:not-suspended': 'conflict',
  'identity:not-suspendable': 'conflict',
  'identity:membership-ended': 'conflict',
  'identity:invalid-dates': 'conflict',
  'identity:guest-term': 'conflict',
}

/** Maps a database error to a contract error. Unknown failures are `unavailable` and fail closed. */
export function translateError(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error
  const message = error instanceof Error ? error.message : ''
  // A confusable or duplicate sibling name, or a second live membership.
  if ((error as { code?: string }).code === '23505') return new IdentityError('conflict', message)
  // Row-level security refused a write outside the transaction's tenants.
  if ((error as { code?: string }).code === '42501') return new IdentityError('forbidden', message)
  const code = DOMAIN_ERRORS[message]
  return code ? new IdentityError(code, message) : new IdentityError('unavailable', message || 'identity database failure')
}

export function database(port: IdentityDatabase & { schema: string }): Database {
  const schema = quoteIdentifier(port.schema, 'schema')
  return {
    schema,
    async transaction(work, context = {}) {
      let client: PoolClientLike
      try {
        client = await port.pool.connect() as PoolClientLike
      }
      catch (error) {
        throw translateError(error)
      }
      try {
        await client.query('begin')
        await client.query(
          `select set_config('identity.tenant_ids', $1, true), set_config('identity.actor_id', $2, true), set_config('identity.correlation_id', $3, true), set_config('identity.at', $4, true)`,
          [`{${(context.tenantIds ?? []).join(',')}}`, context.actorId ?? '', context.correlationId ?? '', context.at?.toISOString() ?? ''],
        )
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
