import type { IdentityDirectory, IdentityDisclosureContextPort, IdentityProvisioning, PostgresPoolLike } from '../../contracts'
import { runIdentityMigrations } from '../database/migrations'
import type { Approvals } from '../internal/approvals'
import { createApprovals } from '../internal/approvals'
import type { MaintenanceResult, RelayResult } from '../internal/background'
import { bootstrapRootGroup, provisionTenant, relayOutbox, runMaintenance } from '../internal/background'
import { database } from '../internal/database'
import { createDirectory } from '../internal/directory'
import { createDisclosure } from '../internal/disclosure'
import type { Governance } from '../internal/governance'
import { createGovernance } from '../internal/governance'
import type { Joining } from '../internal/joining'
import { createJoining } from '../internal/joining'
import { createProvisioning } from '../internal/provisioning'
import { useIdentityAccessDecision, useIdentityApprovalPolicy, useIdentityDatabase, useIdentityEventPublisher, useIdentityPolicy } from './identity-composition'

/**
 * Identity's server functions. Each uses the ports the host supplied and
 * fails closed (`IdentityCompositionError`) when one is missing.
 */

/**
 * Applies Identity's migrations. Call it with the **migration** pool (the
 * role that will own the schema), never the runtime pool, before serving
 * requests; name the runtime role the host connects with at request time.
 */
export function migrateIdentityDatabase(input: { pool: PostgresPoolLike, runtimeRole: string, schema?: string }): Promise<string[]> {
  return runIdentityMigrations(input.pool, input.schema ?? 'identity', input.runtimeRole)
}

/** The provisioning port, for the host's adapter to Authentication. */
export function getIdentityProvisioning(): IdentityProvisioning {
  return createProvisioning(database(useIdentityDatabase()), useIdentityPolicy())
}

/** The directory port, for the host's adapter to Authorisation. */
export function getIdentityDirectory(): IdentityDirectory {
  return createDirectory(database(useIdentityDatabase()))
}

/** The disclosure-context port, for the host's adapter to Profile. */
export function getIdentityDisclosureContext(): IdentityDisclosureContextPort {
  return createDisclosure(database(useIdentityDatabase()))
}

/**
 * Group and membership changes that need no second approver: create and
 * rename groups; pause, resume and leave one's own memberships; remove or
 * suspend a member who is not an owner. Each change is authorised through
 * the access-decision port and announced through the outbox.
 */
export function getIdentityGovernance(): Governance {
  return createGovernance({ db: database(useIdentityDatabase()), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/**
 * Governance changes that need approval (docs/contracts.md §8): `request`,
 * `decide`, `cancel` and `getPendingChange`. Root groups, owners,
 * reparenting, archiving, settings and approval requirements, membership
 * dates and reinstatement, identity suspension and service identities.
 */
export function getIdentityApprovals(): Approvals {
  return createApprovals({
    db: database(useIdentityDatabase()),
    access: useIdentityAccessDecision(),
    approvalPolicy: useIdentityApprovalPolicy(),
    policy: useIdentityPolicy(),
  })
}

/**
 * Joining a group (docs/contracts.md §7): `invite`, `accept`, `decline`,
 * `revoke`, `decideAcceptance` and `listInvitations`; `requestToJoin`,
 * `withdrawJoinRequest`, `decideJoinRequest` and `listJoinRequests`.
 */
export function getIdentityJoining(): Joining {
  return createJoining({ db: database(useIdentityDatabase()), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/** Publishes pending outbox events through the host's publisher. Schedule it frequently. */
export function relayIdentityOutbox(input: { limit?: number } = {}): Promise<RelayResult> {
  return relayOutbox(database(useIdentityDatabase()), useIdentityEventPublisher(), input.limit ?? 100)
}

/**
 * Expires what has run out of time (pending identities, lapsed memberships,
 * unapproved changes) and applies changes whose published delay has ended.
 * Schedule it every few minutes.
 */
export function runIdentityMaintenance(): Promise<MaintenanceResult> {
  return runMaintenance(database(useIdentityDatabase()), undefined, undefined, useIdentityPolicy().approvalExpiryDays)
}

interface OperatorConnection {
  /** The **migration** role's pool: the runtime role cannot create tenants or root groups. */
  pool: PostgresPoolLike
  schema?: string
}

/**
 * The platform operator's tenant provisioning, with the migration pool.
 * Server-only: never expose it over HTTP.
 */
export function provisionIdentityTenant(input: OperatorConnection & { jurisdiction: string, dataRegion: string, externalId?: string | null, correlationId: string }): Promise<{ tenantId: string }> {
  const { pool, schema, ...tenant } = input
  return provisionTenant(database({ dialect: 'postgres', pool, schema: schema ?? 'identity' }), useIdentityPolicy(), tenant)
}

/**
 * The operator's bootstrap of a tenant's first root group and its founding
 * owner, with the migration pool. Refused once the tenant has a root group:
 * later root groups are approved changes. Server-only.
 */
export function bootstrapIdentityRootGroup(input: OperatorConnection & { tenantId: string, name: string, firstOwnerId: string, correlationId: string }): Promise<{ groupId: string }> {
  const { pool, schema, ...group } = input
  return bootstrapRootGroup(database({ dialect: 'postgres', pool, schema: schema ?? 'identity' }), group)
}
