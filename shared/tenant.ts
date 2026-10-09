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
 * - `active` — normal operation.
 * - `closing` — tenant shutdown in progress (iam-integration planned process
 *   "Tenant lifecycle"): no new groups or memberships.
 * - `closed` — its data has been disposed of or exported under its jurisdiction.
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
  version: versionSchema,
})

export type TenantRecord = z.infer<typeof tenantSchema>
