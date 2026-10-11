import { z } from 'zod'
import type { IdentityAccessDecision, IdentitySubject, ServiceIdentity, ServiceIdentityAudience } from '../../contracts'
import {
  IdentityError,
  checkSafeName,
  confusableSkeleton,
  correlationIdSchema,
  identifierSchema,
  identitySubjectSchema,
  serviceIdentityAudienceSchema,
  serviceIdentityListSchema,
  serviceIdentitySchema,
} from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Service identities (docs/contracts.md §23; iam-integration's
 * service identities process): what their owning group's administrators do
 * that needs no approval (naming, listing, taking a service identity out of
 * a group), Authentication's question whether a person may manage one's
 * credentials, and who hears of those credentials. Creation, joining a group,
 * suspension, reinstatement and closure are approved governance changes
 * (`server/internal/approvals.ts`). Everything is decided through the
 * access-decision port with `identity.service-identities:manage` in the
 * owning group, and anything unknown is `forbidden`, as is anything the
 * caller may not see.
 */

export interface ServiceIdentitiesDependencies {
  db: Database
  access: IdentityAccessDecision
  clock?: Clock
}

const MANAGE = 'identity.service-identities:manage'

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

interface Facts { identityId: string, state: string, owningGroupId: string, tenantId: string }

export function createServiceIdentities({ db, access, clock = systemClock }: ServiceIdentitiesDependencies) {
  async function facts(identityId: string): Promise<Facts | null> {
    const { rows } = await db.transaction(client => client.query<{ result: Facts | null }>(`select ${db.schema}.service_identity_facts($1) as result`, [identityId]))
    return rows[0]?.result ?? null
  }

  async function decide(subject: IdentitySubject, groupId: string, correlationId: string) {
    try {
      return await access.decide({ subject, permission: MANAGE, groupId, correlationId })
    }
    catch {
      throw new IdentityError('unavailable', 'access decision failed')
    }
  }

  /** The service identity, when the subject may manage it now; `forbidden` otherwise, whether or not it exists. */
  async function managed(subject: IdentitySubject, identityId: string, correlationId: string): Promise<Facts> {
    const found = await facts(identityId)
    if (!found) throw new IdentityError('forbidden')
    const decision = await decide(subject, found.owningGroupId, correlationId)
    if (!decision.allowed) throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
    return found
  }

  async function read(identityId: string): Promise<ServiceIdentity> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_service_identity($1) as result`, [identityId]))
    if (!rows[0]?.result) throw new IdentityError('forbidden')
    return serviceIdentitySchema.parse(rows[0].result)
  }

  return {
    /** The service identities a group owns, closed ones excepted, for those who may manage them. */
    async list(input: { subject: IdentitySubject, groupId: string, correlationId: string }) {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const decision = await decide(subject, groupId, correlationId)
      if (!decision.allowed) throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.list_service_identities($1) as result`, [groupId]))
      return serviceIdentityListSchema.parse(rows[0]?.result)
    },

    /** One service identity, for those who may manage it. */
    async get(input: { subject: IdentitySubject, identityId: string, correlationId: string }): Promise<ServiceIdentity> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      await managed(subject, identityId, correlationId)
      return read(identityId)
    },

    /** Renames a service identity: a safe name, not confusable with another of the group's. No approval: a name confers nothing. */
    async rename(input: { subject: IdentitySubject, identityId: string, name: string, correlationId: string }): Promise<ServiceIdentity> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const checked = checkSafeName(parse(() => z.string().parse(input.name)))
      if (!checked.ok) throw new IdentityError('validation-failed', checked.problem)
      const found = await managed(subject, identityId, correlationId)
      if (found.state === 'closed') throw new IdentityError('forbidden')
      const now = clock.now()
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.rename_service_identity($1, $2, $3, $4, $5, $6) as result`,
        [identityId, checked.value, confusableSkeleton(checked.value), subject.principalId, correlationId, now],
      ), { tenantIds: [found.tenantId], actorId: subject.principalId, correlationId, at: now })
      return serviceIdentitySchema.parse(rows[0]!.result)
    },

    /**
     * Takes a service identity out of a group, as a person leaves: it ends
     * access, never grants it, so it needs no approval. The group's own
     * administrators remove it as they remove any member.
     */
    async leave(input: { subject: IdentitySubject, identityId: string, groupId: string, correlationId: string }): Promise<ServiceIdentity> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const found = await managed(subject, identityId, correlationId)
      const now = clock.now()
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.end_service_membership($1, $2, $3, $4, $5) as result`,
        [identityId, groupId, subject.principalId, correlationId, now],
      ), { tenantIds: [found.tenantId], actorId: subject.principalId, correlationId, at: now })
      return serviceIdentitySchema.parse(rows[0]!.result)
    },

    /**
     * Authentication's service-governance question, through iam-integration:
     * whether the subject may issue, list or revoke the service identity's
     * credentials now. True only for an active service identity whose owning
     * group's `identity.service-identities:manage` the subject holds at the
     * assurance it needs. False otherwise, an unknown identity or a person
     * included; a failing port rejects.
     */
    async mayManageCredentials(input: { subject: IdentitySubject, identityId: string, correlationId: string }): Promise<boolean> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const found = await facts(identityId)
      if (!found || found.state !== 'active') return false
      return (await decide(subject, found.owningGroupId, correlationId)).allowed
    },

    /** Who hears of a live service identity's credentials: its owning group and that group's active owners. Null for anything else. */
    async describe(input: { identityId: string, correlationId: string }): Promise<ServiceIdentityAudience | null> {
      const identityId = parse(() => identifierSchema.parse(input.identityId))
      parse(() => correlationIdSchema.parse(input.correlationId))
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.service_identity_audience($1, $2) as result`,
        [identityId, clock.now()],
      ))
      return rows[0]?.result ? serviceIdentityAudienceSchema.parse(rows[0].result) : null
    },
  }
}

export type ServiceIdentities = ReturnType<typeof createServiceIdentities>
