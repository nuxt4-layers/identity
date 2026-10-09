import type { BreakGlassAction, BreakGlassReview, IdentityAccessDecision, IdentityPolicy, IdentitySubject } from '../../contracts'
import {
  BREAK_GLASS_ACTIONS,
  breakGlassReviewSchema,
  correlationIdSchema,
  IdentityError,
  identifierSchema,
  identitySubjectSchema,
  mayCloseReview,
  meetsStepUp,
  reasonCodeSchema,
  STEP_UP_REQUIREMENTS,
} from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. Identity's part of ADR-0007 (docs/contracts.md §13). A
 * break-glass identity may, at once and without a second approver:
 * suspend an identity, suspend a membership, or appoint an owner to an
 * orphaned group. Nothing else. Every use opens a review, which only
 * another person who did not hold the passkey can close, and writes
 * `break-glass.used` for the host to alert every operator and owner
 * affected. It needs phishing-resistant, fresh authentication, which a
 * passkey gives.
 */

export interface BreakGlassDependencies {
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

export function createBreakGlass({ db, access, policy, clock = systemClock }: BreakGlassDependencies) {
  async function review(reviewId: string): Promise<BreakGlassReview | null> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_break_glass_review($1) as result`, [reviewId]))
    return rows[0]?.result ? breakGlassReviewSchema.parse(rows[0].result) : null
  }

  return {
    /**
     * A break-glass action. `targetId` is the identity to suspend, the
     * membership to suspend, or, for `appoint-owner`, the membership of the
     * active member to make owner of its orphaned group.
     */
    async act(input: { subject: IdentitySubject, action: BreakGlassAction, targetId: string, reasonCode: string, correlationId: string }): Promise<BreakGlassReview> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const targetId = parse(() => identifierSchema.parse(input.targetId))
      const reasonCode = parse(() => reasonCodeSchema.parse(input.reasonCode))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      if (!(BREAK_GLASS_ACTIONS as readonly string[]).includes(input.action)) throw new IdentityError('validation-failed')
      const now = clock.now()
      if (!meetsStepUp({ level: subject.assurance.level, phishingResistant: subject.assurance.phishingResistant, authenticatedAt: subject.authenticatedAt }, STEP_UP_REQUIREMENTS.critical, now)) {
        throw new IdentityError('insufficient-assurance')
      }
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.break_glass_act($1, $2, $3, $4, $5, $6) as result`,
          [subject.principalId, input.action, targetId, reasonCode, correlationId, now],
        ),
        { actorId: subject.principalId, correlationId, at: now },
      )
      return breakGlassReviewSchema.parse(rows[0]!.result)
    },

    /**
     * Closes a review with an outcome code (`identity.break-glass-reviews:close`
     * in the platform group). The host attests whether the closer held the
     * passkey for the action under review; if so, or if the closer is the
     * break-glass identity, it is refused.
     */
    async closeReview(input: { subject: IdentitySubject, reviewId: string, outcome: string, closerHeldPasskey: boolean, correlationId: string }): Promise<BreakGlassReview> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const reviewId = parse(() => identifierSchema.parse(input.reviewId))
      const outcome = parse(() => reasonCodeSchema.parse(input.outcome))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      if (typeof input.closerHeldPasskey !== 'boolean') throw new IdentityError('validation-failed')
      if (!policy.platformGroupId) throw new IdentityError('forbidden', 'no platform group is configured')
      const found = await review(reviewId)
      if (!found) throw new IdentityError('forbidden')
      let decision
      try {
        decision = await access.decide({ subject, permission: 'identity.break-glass-reviews:close', groupId: policy.platformGroupId, correlationId })
      }
      catch {
        throw new IdentityError('unavailable', 'access decision failed')
      }
      if (!decision.allowed) throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
      if (!mayCloseReview(found, subject.principalId, input.closerHeldPasskey)) throw new IdentityError('conflict', 'may not close this review')
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.close_break_glass_review($1, $2, $3, $4, $5) as result`,
          [reviewId, subject.principalId, outcome, correlationId, now],
        ),
        { actorId: subject.principalId, correlationId, at: now },
      )
      return breakGlassReviewSchema.parse(rows[0]!.result)
    },
  }
}

export type BreakGlass = ReturnType<typeof createBreakGlass>
