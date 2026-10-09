import { z } from 'zod'
import { correlationIdSchema, identifierSchema } from './identifiers'
import type { IdentityEvent } from './events'
import type { IdentityPermissionName, IdentityRiskLevel } from './permissions'
import type { StepUpRequirement } from './approvals'

/**
 * Ports Identity consumes, supplied by the host (docs/contracts.md §10).
 * Each is declared structurally: Identity imports no other member's package.
 */

/**
 * Structural shape of a PostgreSQL connection pool, as provided by the `pg`
 * driver's `Pool`, so that the contract does not depend on a driver.
 */
export interface PostgresPoolLike {
  query(text: string, values?: readonly unknown[]): Promise<unknown>
  connect(): Promise<unknown>
  end(): Promise<void>
}

/** Persistence port (ADR-0002). The host owns the pool; the layer owns its schema. */
export interface IdentityDatabase {
  dialect: 'postgres'
  pool: PostgresPoolLike
  /** Schema owned by this capability. Defaults to `identity`. */
  schema?: string
}

/**
 * Who is asking, as Authentication established it on the server. A
 * structural subset of Authentication's `AuthenticatedPrincipal`, whose
 * `principalId` is the identity identifier.
 */
export const identitySubjectSchema = z.strictObject({
  principalId: identifierSchema,
  authenticatedAt: z.iso.datetime(),
  assurance: z.strictObject({
    level: z.enum(['aal1', 'aal2']),
    phishingResistant: z.boolean(),
  }),
})

export type IdentitySubject = z.infer<typeof identitySubjectSchema>

export type AccessDecision =
  | { allowed: true }
  | { allowed: false, reason: 'not-permitted' }
  | { allowed: false, reason: 'insufficient-assurance', requirement: StepUpRequirement }

/**
 * Access-decision port, supplied from Authorisation. Identity asks it before
 * every governance or membership change it does not reserve to the person
 * themselves. A failure rejects, and Identity refuses (`unavailable`).
 */
export interface IdentityAccessDecision {
  decide(input: {
    subject: IdentitySubject
    permission: IdentityPermissionName
    /** The group the action is on. For a tenant-level action, the tenant's root group. */
    groupId: string
    correlationId: string
  }): Promise<AccessDecision>
}

/**
 * Approval-policy port, supplied from Authorisation (architecture §3).
 * Identity decides how many approvers a change needs; Authorisation says who
 * qualifies. Every read is `strong`.
 */
export interface IdentityApprovalPolicy {
  /** The risk level of a permission in the host's catalogue, or null if it is missing (refused). */
  riskOf(permission: IdentityPermissionName): Promise<IdentityRiskLevel | null>
  /** Whether `approverId` holds `permission` in the group now (or through a covering assignment). */
  qualifies(input: { approverId: string, permission: IdentityPermissionName, groupId: string }): Promise<boolean>
  /** How many principals other than `excludingId` qualify, capped at `limit`. */
  countQualifying(input: { permission: IdentityPermissionName, groupId: string, excludingId: string, limit: number }): Promise<number>
}

/**
 * Event publisher, supplied by the host's outbox relay. The relay reads
 * Identity's outbox and publishes each event at least once; Identity marks it
 * relayed only when `publish` resolves.
 */
export interface IdentityEventPublisher {
  publish(event: IdentityEvent): Promise<void>
}

/** Every call through these ports carries the request's correlation identifier. */
export const portCallContextSchema = z.strictObject({ correlationId: correlationIdSchema })
