import type { Disposal, IdentityAccessDecision, IdentityPolicy, IdentitySubject, LegalHoldSubjectKind, TenantGovernanceExport } from '../../contracts'
import {
  IdentityError,
  LEGAL_HOLD_SUBJECT_KINDS,
  STEP_UP_REQUIREMENTS,
  TENANT_EXPORT_MAX_RECORDS,
  correlationIdSchema,
  disposalMemberSchema,
  disposalSchema,
  identifierSchema,
  identitySubjectSchema,
  meetsStepUp,
  tenantExportSchema,
} from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. End of life (docs/contracts.md §22; iam-integration's group
 * deletion and tenant lifecycle): legal holds on groups and tenants as the
 * other members' retention and disposal ask about them, members'
 * confirmations that they have disposed of a deleted group's or closed
 * tenant's information, and a closing tenant's governance export.
 * Deletion, shutdown and holds themselves are approved governance changes
 * (`group.delete`, `tenant.close`, `tenant.cancel-closing`,
 * `legal-hold.place`, `legal-hold.release`).
 */

export interface EndOfLifeDependencies {
  db: Database
  access: IdentityAccessDecision
  policy: IdentityPolicy
  clock?: Clock
}

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

function subjectOf(input: { kind: unknown, id: unknown }): { kind: LegalHoldSubjectKind, id: string } {
  if (!LEGAL_HOLD_SUBJECT_KINDS.includes(input.kind as LegalHoldSubjectKind)) throw new IdentityError('validation-failed')
  return { kind: input.kind as LegalHoldSubjectKind, id: parse(() => identifierSchema.parse(input.id)) }
}

/** Server-only: whether a legal hold covers a group (directly or through its tenant) or a tenant now. */
export async function legalHoldCovers(db: Database, input: { kind: LegalHoldSubjectKind, id: string }, clock: Clock = systemClock): Promise<boolean> {
  const subject = subjectOf(input)
  const now = clock.now()
  const { rows } = await db.transaction(client => client.query<{ covered: boolean }>(
    `select ${db.schema}.legal_hold_covers($1, $2, $3) as covered`,
    [subject.kind, subject.id, now],
  ), { at: now })
  return rows[0]?.covered === true
}

/**
 * Server-only: a member's confirmation that it has disposed of its part of a
 * deleted group or closed tenant, relayed from its `<member>.group-disposed`
 * or `<member>.tenant-disposed` event. Idempotent. A confirmation for a
 * disposal that is unknown or not yet due is not recorded.
 */
export async function recordDisposal(
  db: Database,
  input: { subject: { kind: LegalHoldSubjectKind, id: string }, member: string, eventId: string, correlationId: string },
  clock: Clock = systemClock,
): Promise<{ recorded: boolean }> {
  const subject = subjectOf(input.subject)
  const member = parse(() => disposalMemberSchema.parse(input.member))
  const eventId = parse(() => identifierSchema.parse(input.eventId))
  const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
  const now = clock.now()
  const { rows } = await db.transaction(client => client.query<{ recorded: boolean }>(
    `select ${db.schema}.record_disposal($1, $2, $3, $4, $5) as recorded`,
    [subject.kind, subject.id, member, eventId, now],
  ), { correlationId, at: now })
  return { recorded: rows[0]?.recorded === true }
}

/** Server-only, for operators' tooling: a disposal and who has confirmed it, or null. */
export async function readDisposal(db: Database, input: { kind: LegalHoldSubjectKind, id: string }): Promise<Disposal | null> {
  const subject = subjectOf(input)
  const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_disposal($1, $2) as result`, [subject.kind, subject.id]))
  return rows[0]?.result ? disposalSchema.parse(rows[0].result) : null
}

export function createTenantExport({ db, access, clock = systemClock }: EndOfLifeDependencies) {
  return {
    /**
     * A closing tenant's governance records, for an owner of one of its root
     * groups (`identity.tenants:export`, `high`, at `aal2`), during its
     * notice period. Null for an unknown tenant is never returned to a
     * caller who may not see it: both are `forbidden`. Each download is
     * announced (`tenant.exported`).
     */
    async exportTenant(input: { subject: IdentitySubject, tenantId: string, correlationId: string }): Promise<TenantGovernanceExport> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const tenantId = parse(() => identifierSchema.parse(input.tenantId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const { rows: facts } = await db.transaction(client => client.query<{ result: { state: string, rootGroupIds: string[] } | null }>(
        `select ${db.schema}.tenant_facts($1) as result`,
        [tenantId],
      ))
      const tenant = facts[0]?.result
      if (!tenant) throw new IdentityError('forbidden')
      let allowed = false
      let stepUp = false
      for (const groupId of tenant.rootGroupIds) {
        let decision
        try {
          decision = await access.decide({ subject, permission: 'identity.tenants:export', groupId, correlationId })
        }
        catch {
          throw new IdentityError('unavailable', 'access decision failed')
        }
        if (decision.allowed) {
          allowed = true
          break
        }
        if (decision.reason === 'insufficient-assurance') stepUp = true
      }
      if (!allowed) throw new IdentityError(stepUp ? 'insufficient-assurance' : 'forbidden')
      const now = clock.now()
      const assurance = { level: subject.assurance.level, phishingResistant: subject.assurance.phishingResistant, authenticatedAt: subject.authenticatedAt }
      if (!meetsStepUp(assurance, STEP_UP_REQUIREMENTS.high, now)) throw new IdentityError('insufficient-assurance')
      if (tenant.state !== 'closing') throw new IdentityError('conflict', 'tenant is not closing')
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.export_tenant($1, $2, $3, $4, $5) as result`,
        [tenantId, subject.principalId, correlationId, now, TENANT_EXPORT_MAX_RECORDS],
      ), { tenantIds: [tenantId], actorId: subject.principalId, correlationId, at: now })
      if (!rows[0]?.result) throw new IdentityError('forbidden')
      return tenantExportSchema.parse(rows[0].result)
    },
  }
}
