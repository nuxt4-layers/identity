import type { IdentityDirectory, IdentityDisclosureContextPort, IdentityProvisioning, PostgresPoolLike } from '../../contracts'
import { runIdentityMigrations } from '../database/migrations'
import type { MaintenanceResult, RelayResult } from '../internal/background'
import { provisionTenant, relayOutbox, runMaintenance } from '../internal/background'
import { database } from '../internal/database'
import { createDirectory } from '../internal/directory'
import { createDisclosure } from '../internal/disclosure'
import type { Governance } from '../internal/governance'
import { createGovernance } from '../internal/governance'
import { createProvisioning } from '../internal/provisioning'
import { useIdentityAccessDecision, useIdentityDatabase, useIdentityEventPublisher, useIdentityPolicy } from './identity-composition'

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

/** Publishes pending outbox events through the host's publisher. Schedule it frequently. */
export function relayIdentityOutbox(input: { limit?: number } = {}): Promise<RelayResult> {
  return relayOutbox(database(useIdentityDatabase()), useIdentityEventPublisher(), input.limit ?? 100)
}

/** Expires what has run out of time: pending identities and lapsed memberships. Schedule it every few minutes. */
export function runIdentityMaintenance(): Promise<MaintenanceResult> {
  return runMaintenance(database(useIdentityDatabase()))
}

/** The platform operator's tenant provisioning. Server-only: never expose it over HTTP. */
export function provisionIdentityTenant(input: { jurisdiction: string, dataRegion: string, externalId?: string | null, correlationId: string }): Promise<{ tenantId: string }> {
  return provisionTenant(database(useIdentityDatabase()), useIdentityPolicy(), input)
}
