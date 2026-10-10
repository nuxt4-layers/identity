import { z } from 'zod'
import { externalIdSchema, identifierSchema, instantSchema, registryCodeSchema, versionSchema } from './identifiers'

/**
 * Tenancy (docs/contracts.md §4). A tenant is an isolation boundary, not a
 * group. It lives inside Identity as its own entity, contract section and
 * module, so that it can move to a separate tenancy capability later
 * (ADR-0003 guardrail) without changing what other members see.
 *
 * Nothing here imports the rest of Identity's contract, and nothing outside
 * this module reads a tenant's fields except through `tenantSchema`.
 */

/**
 * iam-integration's tenant lifecycle:
 * - `active` — normal operation.
 * - `closing` — the notice period before shutdown: no new groups,
 *   memberships or accepted invitations; the root groups' owners may export
 *   the tenant's governance records; people whose home tenant it is will be
 *   re-homed. Cancellable until `closesAt`.
 * - `closed` — every group in it deleted; a tombstone with its jurisdiction
 *   and data region remains.
 */
export const TENANT_STATES = ['active', 'closing', 'closed'] as const
export type TenantState = typeof TENANT_STATES[number]

export const tenantSchema = z.strictObject({
  tenantId: identifierSchema,
  externalId: externalIdSchema.nullable(),
  state: z.enum(TENANT_STATES),
  /** Selects the tenant's policy pack (UK GDPR, EU GDPR, CCPA and so on). A code the host registers. */
  jurisdiction: registryCodeSchema,
  /**
   * Where the tenant's data is stored, including derived copies and backups
   * (ADR-0006 §7). Set once, at provisioning; changing it is a migration
   * process, not an edit.
   */
  dataRegion: registryCodeSchema,
  createdAt: instantSchema,
  /** For a `closing` tenant: when its notice period ends and it closes. */
  closesAt: instantSchema.nullable(),
  version: versionSchema,
})

export type TenantRecord = z.infer<typeof tenantSchema>
