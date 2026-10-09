import { randomBytes } from 'node:crypto'
import type { GroupDescription, IdentityAccessDecision, IdentityPermissionName, IdentityPolicy, IdentitySubject, InvitationRecord, JoinRequestRecord } from '../../contracts'
import {
  correlationIdSchema,
  groupDescriptionSchema,
  IdentityError,
  identifierSchema,
  identitySubjectSchema,
  INVITATION_ACKNOWLEDGEMENT,
  INVITATION_TOKEN_BYTES,
  instantSchema,
  invitationSchema,
  invitationTokenSchema,
  joinRequestSchema,
  refuseConfirmation,
  refuseJoinDecision,
} from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { invitationTokenDigest, systemClock } from './provisioning'

/**
 * PRIVATE. Joining a group (docs/contracts.md §7, §7.1): invitations and join
 * requests.
 *
 * The token is generated here and returned to the inviter once; only its
 * SHA-256 digest is stored, and the address it is sent to never reaches
 * Identity. Accepting and declining answer `INVITATION_ACKNOWLEDGEMENT`
 * whatever happened, unless rate-limited, so that tokens, groups and
 * identities cannot be probed. Nobody joins without their own consent, and
 * nobody admits themselves: an inviter cannot accept their own invitation,
 * and nobody confirms their own acceptance or decides their own request.
 */

export interface JoiningDependencies {
  db: Database
  access: IdentityAccessDecision
  policy: IdentityPolicy
  clock?: Clock
}

const DAY = 86_400_000

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

export function createJoining({ db, access, policy, clock = systemClock }: JoiningDependencies) {
  async function authorise(subject: IdentitySubject, permission: IdentityPermissionName, groupId: string, correlationId: string): Promise<void> {
    let decision
    try {
      decision = await access.decide({ subject, permission, groupId, correlationId })
    }
    catch {
      throw new IdentityError('unavailable', 'access decision failed')
    }
    if (decision.allowed) return
    throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
  }

  async function standardGroup(groupId: string): Promise<GroupDescription> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.describe_group($1) as result`, [groupId]))
    const group = rows[0]?.result ? groupDescriptionSchema.parse(rows[0].result) : null
    if (!group || group.kind !== 'standard') throw new IdentityError('forbidden')
    return group
  }

  async function invitation(invitationId: string): Promise<InvitationRecord> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_invitation($1) as result`, [invitationId]))
    if (!rows[0]?.result) throw new IdentityError('forbidden')
    return invitationSchema.parse(rows[0].result)
  }

  async function joinRequest(joinRequestId: string): Promise<JoinRequestRecord> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_join_request($1) as result`, [joinRequestId]))
    if (!rows[0]?.result) throw new IdentityError('forbidden')
    return joinRequestSchema.parse(rows[0].result)
  }

  async function respond(fn: 'accept_invitation' | 'decline_invitation', input: { subject: IdentitySubject, token: string, correlationId: string }) {
    const subject = parse(() => identitySubjectSchema.parse(input.subject))
    const token = parse(() => invitationTokenSchema.parse(input.token))
    const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
    const now = clock.now()
    const args = fn === 'accept_invitation'
      ? [invitationTokenDigest(token), subject.principalId, correlationId, now, policy.acceptanceAttemptsPerHour]
      : [invitationTokenDigest(token), subject.principalId, now, policy.acceptanceAttemptsPerHour]
    const placeholders = args.map((_, index) => `$${index + 1}`).join(', ')
    const { rows } = await db.transaction(client => client.query<{ outcome: string }>(`select ${db.schema}.${fn}(${placeholders}) as outcome`, args))
    if (rows[0]?.outcome === 'rate-limited') throw new IdentityError('rate-limited')
    return INVITATION_ACKNOWLEDGEMENT
  }

  return {
    /**
     * Creates an invitation to `groupId` (`identity.invitations:manage`).
     * Returns the token once: hand it, with the address, to the host's
     * delivery. Bound to `inviteeIdentityId` when given.
     */
    async invite(input: {
      subject: IdentitySubject
      groupId: string
      kind: 'member' | 'guest'
      inviteeIdentityId?: string | null
      membershipStartsAt?: string | null
      membershipEndsAt?: string | null
      correlationId: string
    }): Promise<{ invitationId: string, token: string, expiresAt: string, requiresConfirmation: boolean }> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const inviteeIdentityId = input.inviteeIdentityId == null ? null : parse(() => identifierSchema.parse(input.inviteeIdentityId))
      const startsAt = input.membershipStartsAt == null ? null : parse(() => instantSchema.parse(input.membershipStartsAt))
      const endsAt = input.membershipEndsAt == null ? null : parse(() => instantSchema.parse(input.membershipEndsAt))
      if (input.kind !== 'member' && input.kind !== 'guest') throw new IdentityError('validation-failed')
      const group = await standardGroup(groupId)
      await authorise(subject, 'identity.invitations:manage', group.groupId, correlationId)
      const now = clock.now()
      const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url')
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(`select ${db.schema}.create_invitation($1::jsonb) as result`, [JSON.stringify({
          groupId,
          kind: input.kind,
          inviteeIdentityId,
          tokenDigest: invitationTokenDigest(token),
          invitedBy: subject.principalId,
          membershipStartsAt: startsAt,
          membershipEndsAt: endsAt,
          expiresAt: new Date(now.getTime() + policy.invitationExpiryDays * DAY).toISOString(),
          perInviterPerHour: policy.invitationsPerInviterPerHour,
          perGroupPerDay: policy.invitationsPerGroupPerDay,
          at: now.toISOString(),
        })]),
        { tenantIds: [group.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      const created = invitationSchema.parse(rows[0]!.result)
      return { invitationId: created.invitationId, token, expiresAt: created.expiresAt, requiresConfirmation: created.requiresConfirmation }
    },

    /** The signed-in holder of the token accepts. Always `INVITATION_ACKNOWLEDGEMENT`, unless `rate-limited`. */
    accept(input: { subject: IdentitySubject, token: string, correlationId: string }) {
      return respond('accept_invitation', input)
    },

    /** The signed-in holder of the token declines. Always `INVITATION_ACKNOWLEDGEMENT`, unless `rate-limited`. */
    decline(input: { subject: IdentitySubject, token: string, correlationId: string }) {
      return respond('decline_invitation', input)
    },

    /** Revokes an open or awaiting invitation (`identity.invitations:manage`). */
    async revoke(input: { subject: IdentitySubject, invitationId: string, correlationId: string }): Promise<InvitationRecord> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const found = await invitation(parse(() => identifierSchema.parse(input.invitationId)))
      await authorise(subject, 'identity.invitations:manage', found.groupId, correlationId)
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(`select ${db.schema}.revoke_invitation($1, $2, $3) as result`, [found.invitationId, subject.principalId, now]),
        { tenantIds: [found.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      return invitationSchema.parse(rows[0]!.result)
    },

    /**
     * Confirms who accepted an invitation awaiting confirmation, creating the
     * membership, or refuses them (`identity.invitations:manage`). Nobody
     * confirms their own acceptance; the inviter may.
     */
    async decideAcceptance(input: { subject: IdentitySubject, invitationId: string, decision: 'confirm' | 'refuse', correlationId: string }): Promise<InvitationRecord> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      if (input.decision !== 'confirm' && input.decision !== 'refuse') throw new IdentityError('validation-failed')
      const found = await invitation(parse(() => identifierSchema.parse(input.invitationId)))
      await authorise(subject, 'identity.invitations:manage', found.groupId, correlationId)
      const refusal = refuseConfirmation(found, subject.principalId)
      if (refusal) throw new IdentityError('conflict', refusal)
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.decide_invitation($1, $2, $3, $4, $5, $6) as result`,
          [found.invitationId, subject.principalId, input.decision, correlationId, now, policy.approvalExpiryDays],
        ),
        { tenantIds: [found.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      return invitationSchema.parse(rows[0]!.result)
    },

    /** A group's invitations, newest first (`identity.invitations:manage`). */
    async listInvitations(input: { subject: IdentitySubject, groupId: string, correlationId: string, limit?: number }): Promise<InvitationRecord[]> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const limit = input.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new IdentityError('validation-failed')
      const group = await standardGroup(parse(() => identifierSchema.parse(input.groupId)))
      await authorise(subject, 'identity.invitations:manage', group.groupId, correlationId)
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.invitation_json(i) as result from ${db.schema}.invitation i where i.group_id = $1 order by i.created_at desc, i.invitation_id limit $2`,
          [group.groupId, limit],
        ),
        { tenantIds: [group.tenantId] },
      )
      return rows.map(row => invitationSchema.parse(row.result))
    },

    /**
     * Asks to join a group in one's tenant: joins at once where the group's
     * joining is open, otherwise records a request where requests are on.
     */
    async requestToJoin(input: { subject: IdentitySubject, groupId: string, correlationId: string }): Promise<{ outcome: 'joined' | 'requested', joinRequestId: string | null }> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const groupId = parse(() => identifierSchema.parse(input.groupId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: { outcome: 'joined' | 'requested', joinRequestId: string | null } }>(
          `select ${db.schema}.request_join($1, $2, $3, $4, $5) as result`,
          [groupId, subject.principalId, correlationId, now, new Date(now.getTime() + policy.approvalExpiryDays * DAY)],
        ),
        { actorId: subject.principalId, correlationId, at: now },
      )
      return rows[0]!.result
    },

    /** The person withdraws their own open request. */
    async withdrawJoinRequest(input: { subject: IdentitySubject, joinRequestId: string, correlationId: string }): Promise<JoinRequestRecord> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const joinRequestId = parse(() => identifierSchema.parse(input.joinRequestId))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(`select ${db.schema}.withdraw_join_request($1, $2, $3, $4) as result`, [joinRequestId, subject.principalId, correlationId, now]),
        { actorId: subject.principalId, correlationId, at: now },
      )
      return joinRequestSchema.parse(rows[0]!.result)
    },

    /** Approves, creating an ordinary membership, or refuses a request (`identity.join-requests:decide`). */
    async decideJoinRequest(input: { subject: IdentitySubject, joinRequestId: string, decision: 'approve' | 'refuse', correlationId: string }): Promise<JoinRequestRecord> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      if (input.decision !== 'approve' && input.decision !== 'refuse') throw new IdentityError('validation-failed')
      const found = await joinRequest(parse(() => identifierSchema.parse(input.joinRequestId)))
      await authorise(subject, 'identity.join-requests:decide', found.groupId, correlationId)
      const refusal = refuseJoinDecision(found, subject.principalId)
      if (refusal) throw new IdentityError('conflict', refusal)
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.decide_join_request($1, $2, $3, $4, $5) as result`,
          [found.joinRequestId, subject.principalId, input.decision, correlationId, now],
        ),
        { tenantIds: [found.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      return joinRequestSchema.parse(rows[0]!.result)
    },

    /** A group's open join requests, oldest first (`identity.join-requests:decide`). */
    async listJoinRequests(input: { subject: IdentitySubject, groupId: string, correlationId: string }): Promise<JoinRequestRecord[]> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const group = await standardGroup(parse(() => identifierSchema.parse(input.groupId)))
      await authorise(subject, 'identity.join-requests:decide', group.groupId, correlationId)
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.join_request_json(r) as result from ${db.schema}.join_request r where r.group_id = $1 and r.state = 'open' order by r.created_at, r.join_request_id limit 500`,
          [group.groupId],
        ),
        { tenantIds: [group.tenantId] },
      )
      return rows.map(row => joinRequestSchema.parse(row.result))
    },
  }
}

export type Joining = ReturnType<typeof createJoining>
