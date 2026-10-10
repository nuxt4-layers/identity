import type { IdentityAccessGovernance, IdentityDirectory, IdentityDisclosureContextPort, IdentityProvisioning, PostgresPoolLike } from '../../contracts'
import { runIdentityMigrations } from '../database/migrations'
import { createAccessGovernance } from '../internal/access-governance'
import type { Approvals } from '../internal/approvals'
import { createApprovals } from '../internal/approvals'
import type { MaintenanceResult, RelayResult } from '../internal/background'
import { bootstrapRootGroup, provisionBreakGlass, provisionTenant, relayOutbox, runMaintenance } from '../internal/background'
import type { BreakGlass } from '../internal/break-glass'
import { createBreakGlass } from '../internal/break-glass'
import { database } from '../internal/database'
import { createDirectory } from '../internal/directory'
import { createDisclosure } from '../internal/disclosure'
import type { Governance } from '../internal/governance'
import { createGovernance } from '../internal/governance'
import type { Joining } from '../internal/joining'
import { createJoining } from '../internal/joining'
import type { Queries } from '../internal/queries'
import { createQueries, createScimStructure, exportIdentity } from '../internal/queries'
import type { Lifecycle } from '../internal/lifecycle'
import { createLifecycle, recordCredentialRecovery } from '../internal/lifecycle'
import { createProvisioning } from '../internal/provisioning'
import { useIdentityAccessDecision, useIdentityApprovalPolicy, useIdentityClock, useIdentityDatabase, useIdentityEventPublisher, useIdentityPolicy } from './identity-composition'

/**
 * Identity's server functions. Each uses the ports the host supplied and
 * fails closed (`IdentityCompositionError`) when one is missing. Each takes
 * its time from the host's clock (`provideIdentityClock`), or the system
 * clock.
 */

/** The runtime database, its transactions timed by the clock. */
function runtime() {
  const clock = useIdentityClock()
  return { db: database(useIdentityDatabase(), clock), clock }
}

/** The operator's database, with the migration pool, timed by the clock. */
function operator(pool: PostgresPoolLike, schema: string | undefined) {
  const clock = useIdentityClock()
  return { db: database({ dialect: 'postgres', pool, schema: schema ?? 'identity' }, clock), clock }
}

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
  const { db, clock } = runtime()
  return createProvisioning(db, useIdentityPolicy(), clock)
}

/** The directory port, for the host's adapter to Authorisation. */
export function getIdentityDirectory(): IdentityDirectory {
  const { db, clock } = runtime()
  return createDirectory(db, clock)
}

/**
 * The access-governance port, for the host's adapter to Authorisation
 * (docs/contracts.md §10.4; iam-integration
 * `docs/processes/access-administration.md`): `describeGroup` (a group's
 * approval requirement, safety periods in force, parent, root and person,
 * with the requester's recovery hold and the identities they control),
 * `isOwner` and `countOwners`. Every read is `strong`, timed by the clock.
 * Server-only, like the directory: it decides nothing and checks no
 * permission, so never expose it over HTTP.
 */
export function getIdentityAccessGovernance(): IdentityAccessGovernance {
  const { db, clock } = runtime()
  return createAccessGovernance({ db, policy: useIdentityPolicy(), clock })
}

/** The disclosure-context port, for the host's adapter to Profile. */
export function getIdentityDisclosureContext(): IdentityDisclosureContextPort {
  const { db, clock } = runtime()
  return createDisclosure(db, clock)
}

/**
 * Group and membership changes that need no second approver: create and
 * rename groups; pause, resume and leave one's own memberships; remove or
 * suspend a member who is not an owner. Each change is authorised through
 * the access-decision port and announced through the outbox.
 */
export function getIdentityGovernance(): Governance {
  return createGovernance({ ...runtime(), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/**
 * Governance changes that need approval (docs/contracts.md §8): `request`,
 * `decide`, `cancel` and `getPendingChange`. Root groups, owners,
 * reparenting, archiving, settings and approval requirements, membership
 * dates and reinstatement, identity suspension and service identities.
 */
export function getIdentityApprovals(): Approvals {
  return createApprovals({
    ...runtime(),
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
  return createJoining({ ...runtime(), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/**
 * The person's own lifecycle (docs/contracts.md §3.1): `pauseIdentity`,
 * `resumeIdentity`, `requestClosure`, `cancelClosure` and `lastOwnerOf`.
 * Reserved to the person; no permission is asked.
 */
export function getIdentityLifecycle(): Lifecycle {
  return createLifecycle({ ...runtime(), policy: useIdentityPolicy() })
}

/**
 * Records a credential recovery Authentication reported
 * (`authentication.credentials-recovered`), for the recovery hold on
 * `critical` changes. Call it from the host's event relay.
 */
export function recordIdentityCredentialRecovery(input: { identityId: string, recoveredAt: string, correlationId: string }): Promise<{ recorded: boolean }> {
  return recordCredentialRecovery(runtime().db, input)
}

/** Break-glass actions and their reviews (ADR-0007; docs/contracts.md §13): `act` and `closeReview`. */
export function getIdentityBreakGlass(): BreakGlass {
  return createBreakGlass({ ...runtime(), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/**
 * Reads for administration (docs/contracts.md §19): `self` (the signed-in
 * identity's own view), `group`, `members` and `changes`, each authorised
 * through the access-decision port.
 */
export function getIdentityQueries(): Queries {
  return createQueries({ ...runtime(), access: useIdentityAccessDecision(), policy: useIdentityPolicy() })
}

/**
 * Identity's part of a data-subject access request: the identity, its
 * external identifiers and every membership. Server-only; call it from the
 * verified request in iam-integration's data-subject request process.
 */
export function exportIdentityData(input: { identityId: string, correlationId: string }) {
  const { db, clock } = runtime()
  return exportIdentity(db, input, clock)
}

/** The structural part of SCIM users and groups, for the SCIM endpoint the host composes. Server-only. */
export function getIdentityScimStructure() {
  const { db, clock } = runtime()
  return createScimStructure(db, clock)
}

/** Publishes pending outbox events through the host's publisher. Schedule it frequently. */
export function relayIdentityOutbox(input: { limit?: number } = {}): Promise<RelayResult> {
  const { db, clock } = runtime()
  return relayOutbox(db, useIdentityEventPublisher(), input.limit ?? 100, clock)
}

/**
 * Expires what has run out of time (pending identities, lapsed memberships,
 * unapproved changes) and applies changes whose published delay has ended.
 * Schedule it every few minutes.
 */
export function runIdentityMaintenance(): Promise<MaintenanceResult> {
  const { db, clock } = runtime()
  return runMaintenance(db, clock, undefined, useIdentityPolicy().approvalExpiryDays)
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
  const { db, clock } = operator(pool, schema)
  return provisionTenant(db, useIdentityPolicy(), tenant, clock)
}

/**
 * The operator's bootstrap of a tenant's first root group and its founding
 * owner, with the migration pool. Refused once the tenant has a root group:
 * later root groups are approved changes. Server-only.
 */
export function bootstrapIdentityRootGroup(input: OperatorConnection & { tenantId: string, name: string, firstOwnerId: string, correlationId: string }): Promise<{ groupId: string }> {
  const { pool, schema, ...group } = input
  const { db, clock } = operator(pool, schema)
  return bootstrapRootGroup(db, group, clock)
}

/**
 * The operator's provisioning of a break-glass identity (ADR-0007), with the
 * migration pool. Server-only.
 */
export function provisionIdentityBreakGlass(input: OperatorConnection & { homeTenantId: string, correlationId: string }): Promise<{ identityId: string }> {
  const { pool, schema, ...identity } = input
  const { db, clock } = operator(pool, schema)
  return provisionBreakGlass(db, identity, clock)
}
