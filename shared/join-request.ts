import { z } from 'zod'
import { identifierSchema, instantSchema, versionSchema } from './identifiers'

/**
 * Join requests (iam-integration joining and leaving). Where a group's
 * `joining.requests` is on, someone already in the group's tenant may ask to
 * join; an administrator with `identity.join-requests:decide` approves,
 * which creates an ordinary membership, or refuses. Where `joining.open` is
 * on, they join at once instead.
 *
 * A request expires unanswered after the policy's `approvalExpiryDays`. The
 * person may withdraw it. Nobody decides their own request.
 */

export const JOIN_REQUEST_STATES = ['open', 'approved', 'refused', 'withdrawn', 'expired'] as const
export type JoinRequestState = typeof JOIN_REQUEST_STATES[number]

export const joinRequestSchema = z.strictObject({
  joinRequestId: identifierSchema,
  groupId: identifierSchema,
  tenantId: identifierSchema,
  /** Who asked to join. */
  identityId: identifierSchema,
  state: z.enum(JOIN_REQUEST_STATES),
  createdAt: instantSchema,
  expiresAt: instantSchema,
  /** The administrator who approved or refused it. */
  decidedBy: identifierSchema.nullable(),
  decidedAt: instantSchema.nullable(),
  version: versionSchema,
}).superRefine((request, context) => {
  if (request.decidedBy !== null && request.decidedBy === request.identityId) {
    context.addIssue({ code: 'custom', path: ['decidedBy'], message: 'Nobody decides their own request' })
  }
  if ((request.state === 'open') !== (request.decidedAt === null)) {
    context.addIssue({ code: 'custom', path: ['decidedAt'], message: 'Only an open request is undecided' })
  }
})

export type JoinRequestRecord = z.infer<typeof joinRequestSchema>

export const JOIN_DECISION_REFUSALS = ['not-open', 'own-request'] as const
export type JoinDecisionRefusal = typeof JOIN_DECISION_REFUSALS[number]

/** Checks an administrator's decision on a join request. Authorisation decides whether they may decide at all. */
export function refuseJoinDecision(request: Pick<JoinRequestRecord, 'state' | 'identityId'>, deciderId: string): JoinDecisionRefusal | null {
  if (request.state !== 'open') return 'not-open'
  if (request.identityId === deciderId) return 'own-request'
  return null
}
