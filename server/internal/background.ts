import { randomUUID } from 'node:crypto'
import type { IdentityEventPublisher, IdentityPolicy } from '../../contracts'
import { checkSafeName, confusableSkeleton, DEFAULT_GROUP_SETTINGS, identityEventSchema, IdentityError, identifierSchema, registryCodeSchema, externalIdSchema } from '../../contracts'
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
  /** Changes that waited for an approver past their expiry. */
  expiredChanges: number
  /** Changes whose published delay ended: applied, or rejected because a rule no longer held. */
  appliedChanges: number
  rejectedChanges: number
}

/**
 * Closes `pending` identities whose confirmation window has ended, records
 * memberships past their end date as `ended` (`expired`), expires changes
 * nobody approved in time, and applies changes whose published delay has
 * ended. Access already treats lapsed identities and memberships as over;
 * this records it and announces it.
 */
export async function runMaintenance(db: Database, clock: Clock = systemClock, limit = 500): Promise<MaintenanceResult> {
  const correlationId = randomUUID()
  const now = clock.now()
  const { rows } = await db.transaction(client => client.query<{ expired: number, swept: number, changes: { expired: number, applied: number, rejected: number } }>(
    `select ${db.schema}.expire_pending_identities($1, $2, $3) as expired, ${db.schema}.sweep_lapsed_memberships($1, $2, $3) as swept,
       ${db.schema}.run_due_changes($2, $3) as changes`,
    [correlationId, now, limit],
  ))
  const row = rows[0]!
  return {
    expiredPendingIdentities: row.expired,
    endedLapsedMemberships: row.swept,
    expiredChanges: row.changes.expired,
    appliedChanges: row.changes.applied,
    rejectedChanges: row.changes.rejected,
  }
}

/**
 * Provisions a tenant: the platform operator's procedure (iam-integration
 * planned process "Tenant lifecycle"). Server-only; never exposed over HTTP.
 * `db` uses the **migration** role: the runtime role cannot create tenants.
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

/**
 * Creates a tenant's first root group with its founding owner: the
 * operator's bootstrap, with the **migration** role. Refused once the tenant
 * has a root group; every later root group is a `group.create-root` change,
 * approved in the platform group.
 */
export async function bootstrapRootGroup(
  db: Database,
  input: { tenantId: string, name: string, firstOwnerId: string, correlationId: string },
  clock: Clock = systemClock,
): Promise<{ groupId: string }> {
  const tenantId = identifierSchema.safeParse(input.tenantId)
  const firstOwnerId = identifierSchema.safeParse(input.firstOwnerId)
  const name = checkSafeName(input.name)
  if (!tenantId.success || !firstOwnerId.success) throw new IdentityError('validation-failed')
  if (!name.ok) throw new IdentityError('validation-failed', name.problem)
  const now = clock.now()
  return db.transaction(async (client) => {
    const tenant = await client.query<{ state: string }>(`select state from ${db.schema}.tenant where tenant_id = $1 for update`, [tenantId.data])
    if (tenant.rows[0]?.state !== 'active') throw new IdentityError('validation-failed', 'tenant is not active')
    const existing = await client.query(`select 1 from ${db.schema}."group" where tenant_id = $1 and kind = 'standard' and parent_group_id is null`, [tenantId.data])
    if (existing.rows.length > 0) throw new IdentityError('conflict', 'the tenant already has a root group; request group.create-root')
    const owner = await client.query<{ result: { kind: string, state: string } | null }>(`select ${db.schema}.sign_in_status($1) as result`, [firstOwnerId.data])
    if (owner.rows[0]?.result?.kind !== 'person' || owner.rows[0].result.state !== 'active') throw new IdentityError('conflict', 'first owner must be an active person')
    const { rows: issued } = await client.query<{ id: string }>(`select ${db.schema}.uuid_v7()::text as id`)
    await client.query(`insert into ${db.schema}.founding_claim values ($1, $2)`, [issued[0]!.id, firstOwnerId.data])
    const { rows } = await client.query<{ group_id: string }>(
      `insert into ${db.schema}."group" (group_id, tenant_id, kind, parent_group_id, name, name_skeleton, external_id, state, settings, created_at, version)
       values ($1, $2, 'standard', null, $3, $4, null, 'active', $5, $6, 1) returning group_id`,
      [issued[0]!.id, tenantId.data, name.value, confusableSkeleton(name.value), JSON.stringify(DEFAULT_GROUP_SETTINGS), now],
    )
    const groupId = rows[0]!.group_id
    await client.query(`delete from ${db.schema}.founding_claim where group_id = $1`, [groupId])
    await client.query(
      `insert into ${db.schema}.membership values (${db.schema}.uuid_v7(), $1, $2, $3, 'member', 'active', true, true, $4, null, null, null, null, $4, 1)`,
      [firstOwnerId.data, groupId, tenantId.data, now],
    )
    return { groupId }
  }, { tenantIds: [tenantId.data], actorId: null, correlationId: input.correlationId, at: now })
}
