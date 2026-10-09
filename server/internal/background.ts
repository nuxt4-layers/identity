import { randomUUID } from 'node:crypto'
import type { IdentityEventPublisher, IdentityPolicy } from '../../contracts'
import { identityEventSchema, IdentityError, registryCodeSchema, externalIdSchema } from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Work the host schedules (design decision: host-scheduled server
 * functions). Each step is idempotent and safe to run concurrently: rows are
 * claimed with `FOR UPDATE SKIP LOCKED`. Access never depends on this
 * running: dates and states are evaluated on every read.
 */

export interface RelayResult {
  published: number
  failed: number
}

/**
 * Publishes up to `limit` outbox events, oldest first, at least once. An
 * event is marked published only after the publisher resolves; one that
 * fails stays in the outbox, and later events in the batch wait for the
 * next run so that each aggregate's events keep their order.
 */
export async function relayOutbox(db: Database, publisher: IdentityEventPublisher, limit: number, clock: Clock = systemClock): Promise<RelayResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new IdentityError('validation-failed', 'limit must be 1 to 1000')
  return db.transaction(async (client) => {
    const { rows } = await client.query<{ sequence: string, payload: unknown }>(`select * from ${db.schema}.claim_outbox($1)`, [limit])
    const done: string[] = []
    let failed = 0
    for (const row of rows) {
      const parsed = identityEventSchema.safeParse(row.payload)
      if (!parsed.success) {
        // A malformed event is never published; it stays for an operator to inspect.
        console.error(`[identity] outbox event ${row.sequence} does not match the contract; not published`)
        failed = 1
        break
      }
      try {
        await publisher.publish(parsed.data as never)
        done.push(row.sequence)
      }
      catch (error) {
        console.error(`[identity] publishing outbox event ${row.sequence} failed:`, error instanceof Error ? error.message : error)
        failed = 1
        break
      }
    }
    if (done.length > 0) await client.query(`select ${db.schema}.mark_outbox_published($1::bigint[], $2)`, [done, clock.now()])
    return { published: done.length, failed }
  })
}

export interface MaintenanceResult {
  expiredPendingIdentities: number
  endedLapsedMemberships: number
}

/**
 * Closes `pending` identities whose confirmation window has ended, and
 * records memberships past their end date as `ended` (`expired`). Access
 * already treats both as over; this records it and announces it.
 */
export async function runMaintenance(db: Database, clock: Clock = systemClock, limit = 500): Promise<MaintenanceResult> {
  const correlationId = randomUUID()
  const now = clock.now()
  const { rows } = await db.transaction(client => client.query<{ expired: number, swept: number }>(
    `select ${db.schema}.expire_pending_identities($1, $2, $3) as expired, ${db.schema}.sweep_lapsed_memberships($1, $2, $3) as swept`,
    [correlationId, now, limit],
  ))
  return { expiredPendingIdentities: rows[0]!.expired, endedLapsedMemberships: rows[0]!.swept }
}

/**
 * Provisions a tenant: the platform operator's procedure (iam-integration
 * planned process "Tenant lifecycle"). Server-only; never exposed over HTTP.
 * The jurisdiction and data region must be ones the host registered.
 */
export async function provisionTenant(
  db: Database,
  policy: IdentityPolicy,
  input: { jurisdiction: string, dataRegion: string, externalId?: string | null, correlationId: string },
  clock: Clock = systemClock,
): Promise<{ tenantId: string }> {
  const jurisdiction = registryCodeSchema.safeParse(input.jurisdiction)
  const region = registryCodeSchema.safeParse(input.dataRegion)
  const external = input.externalId == null ? { success: true as const, data: null } : externalIdSchema.safeParse(input.externalId)
  if (!jurisdiction.success || !region.success || !external.success
    || !policy.jurisdictions.includes(jurisdiction.data) || !policy.dataRegions.includes(region.data)) {
    throw new IdentityError('validation-failed', 'jurisdiction and data region must be registered in the identity policy')
  }
  const { rows } = await db.transaction(client => client.query<{ id: string }>(
    `select ${db.schema}.create_tenant($1, $2, $3, $4, $5) as id`,
    [jurisdiction.data, region.data, external.data, input.correlationId, clock.now()],
  ))
  return { tenantId: rows[0]!.id }
}
