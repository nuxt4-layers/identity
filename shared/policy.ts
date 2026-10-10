import { z } from 'zod'
import { identifierSchema, registryCodeSchema } from './identifiers'

/**
 * Identity's policy: periods and limits a host may change within bounds
 * (improvement register D3). Tightening is free. Loosening a setting past its
 * default (a shorter safety delay, a longer expiry) needs a documented risk
 * treatment, referenced in `riskTreatment`; beyond the hard bounds it is
 * refused outright.
 */

interface Bounded {
  default: number
  min: number
  max: number
  /** Which direction is safer. Moving the other way past the default is a loosening. */
  saferWhen: 'longer' | 'shorter'
}

export const IDENTITY_POLICY_BOUNDS = Object.freeze({
  /** Grace period before a requested closure takes effect (account closure). */
  closureGraceDays: { default: 30, min: 7, max: 90, saferWhen: 'longer' },
  /** How long a `pending` identity waits for Authentication's confirmation. */
  pendingConfirmationHours: { default: 24, min: 1, max: 72, saferWhen: 'shorter' },
  /** How long a change awaits an approver before expiring unapplied. */
  approvalExpiryDays: { default: 7, min: 1, max: 14, saferWhen: 'shorter' },
  /** Published delay when no approver exists, for `high` changes. */
  publishedDelayHighHours: { default: 72, min: 24, max: 336, saferWhen: 'longer' },
  /** Published delay when no approver exists, for `critical` changes. */
  publishedDelayCriticalHours: { default: 168, min: 72, max: 720, saferWhen: 'longer' },
  /** Published delay before an orphaned group's longest-standing member becomes owner. */
  orphanRecoveryDelayDays: { default: 14, min: 7, max: 60, saferWhen: 'longer' },
  /** Hold on critical governance changes requested after credential recovery. */
  recoveryHoldHours: { default: 72, min: 24, max: 336, saferWhen: 'longer' },
  /** Invitation lifetime. */
  invitationExpiryDays: { default: 14, min: 1, max: 30, saferWhen: 'shorter' },
  /** Longest guest term a group may set before renewal. */
  guestTermDays: { default: 90, min: 1, max: 365, saferWhen: 'shorter' },
  /** Deepest lineage, root included. */
  maxHierarchyDepth: { default: 10, min: 1, max: 32, saferWhen: 'shorter' },
  /** Invitations one identity may create per hour. */
  invitationsPerInviterPerHour: { default: 50, min: 1, max: 500, saferWhen: 'shorter' },
  /** Invitations one group may issue per day. */
  invitationsPerGroupPerDay: { default: 200, min: 1, max: 5000, saferWhen: 'shorter' },
  /** Invitation acceptance attempts per identity per hour. */
  acceptanceAttemptsPerHour: { default: 20, min: 1, max: 100, saferWhen: 'shorter' },
  /** Notice between a tenant's shutdown being approved and its closing (tenant lifecycle). Platform only. */
  tenantClosingNoticeDays: { default: 30, min: 30, max: 180, saferWhen: 'longer' },
  /**
   * Retention (iam-integration `docs/processes/retention.md`): how long each
   * kind of record is kept once its purpose is over. Shorter than the
   * default needs a risk treatment, as for any loosening.
   */
  /** Outbox events, from delivery. */
  retentionOutboxDays: { default: 30, min: 7, max: 365, saferWhen: 'longer' },
  /** Invitations and acceptance attempts, from use, refusal, revocation or expiry. */
  retentionInvitationDays: { default: 90, min: 14, max: 365, saferWhen: 'longer' },
  /** Join requests, from decision, withdrawal or expiry. */
  retentionJoinRequestDays: { default: 365, min: 30, max: 2555, saferWhen: 'longer' },
  /** Governance changes, from decision, withdrawal or expiry. */
  retentionGovernanceChangeDays: { default: 730, min: 365, max: 2555, saferWhen: 'longer' },
  /** Break-glass reviews, from closure of the review. */
  retentionBreakGlassReviewDays: { default: 2555, min: 730, max: 2555, saferWhen: 'longer' },
} as const satisfies Record<string, Bounded>)

export type IdentityPolicySetting = keyof typeof IDENTITY_POLICY_BOUNDS

export type IdentityPolicyPeriods = { readonly [K in IdentityPolicySetting]: number }

export interface IdentityPolicy extends IdentityPolicyPeriods {
  /** Jurisdiction codes the host supports (each selects a policy pack). */
  jurisdictions: readonly string[]
  /** Data-region codes the host can honour (ADR-0006 §7). */
  dataRegions: readonly string[]
  /** The home tenant for sign-ups that do not come through an invitation. Null: sign-up needs one supplied. */
  defaultHomeTenantId: string | null
  /**
   * The host's platform group: a standard group whose owners and qualifying
   * members are the platform's operators. Platform-wide changes (root
   * groups, suspending or reinstating an identity) are authorised and
   * approved there. Null: those changes are refused.
   */
  platformGroupId: string | null
  /**
   * The members and domain capabilities that dispose of a deleted group's or
   * closed tenant's information and confirm it (iam-integration group
   * deletion), by the prefix of their events: for example `authorisation`
   * and `profile`. Identity raises a disposal not confirmed by every one of
   * them within 7 days. Identity confirms its own part itself.
   */
  disposalParticipants: readonly string[]
  /** Reference to the documented risk treatment for any loosening, or null. */
  riskTreatment: string | null
}

const defaults = Object.fromEntries(
  Object.entries(IDENTITY_POLICY_BOUNDS).map(([key, bound]) => [key, bound.default]),
) as unknown as IdentityPolicyPeriods

export const DEFAULT_IDENTITY_POLICY: IdentityPolicy = Object.freeze({
  ...defaults,
  jurisdictions: Object.freeze(['uk-gdpr']),
  dataRegions: Object.freeze(['uk']),
  defaultHomeTenantId: null,
  platformGroupId: null,
  disposalParticipants: Object.freeze([]),
  riskTreatment: null,
})

const periodInput = Object.fromEntries(
  Object.entries(IDENTITY_POLICY_BOUNDS).map(([key, bound]) => [key, z.number().int().min(bound.min).max(bound.max).optional()]),
) as { [K in IdentityPolicySetting]: z.ZodOptional<z.ZodNumber> }

export const identityPolicyInputSchema = z.strictObject({
  ...periodInput,
  jurisdictions: z.array(registryCodeSchema).min(1).max(64).optional(),
  dataRegions: z.array(registryCodeSchema).min(1).max(64).optional(),
  defaultHomeTenantId: identifierSchema.nullable().optional(),
  platformGroupId: identifierSchema.nullable().optional(),
  disposalParticipants: z.array(registryCodeSchema).max(32).refine(list => new Set(list).size === list.length && !list.includes('identity'), 'Each participant once, and never identity itself').optional(),
  riskTreatment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/).nullable().optional(),
})

export type IdentityPolicyInput = z.input<typeof identityPolicyInputSchema>

/** The settings in `policy` that are looser than their defaults. */
export function loosenedSettings(policy: IdentityPolicyPeriods): IdentityPolicySetting[] {
  return (Object.keys(IDENTITY_POLICY_BOUNDS) as IdentityPolicySetting[]).filter((key) => {
    const bound = IDENTITY_POLICY_BOUNDS[key]
    return bound.saferWhen === 'longer' ? policy[key] < bound.default : policy[key] > bound.default
  })
}

/**
 * Merges host overrides onto the defaults. Refuses values outside the hard
 * bounds, and any loosening without a risk-treatment reference.
 */
export function resolveIdentityPolicy(input: IdentityPolicyInput = {}): IdentityPolicy {
  const parsed = identityPolicyInputSchema.parse(input)
  const merged = Object.fromEntries(
    Object.entries({ ...DEFAULT_IDENTITY_POLICY, ...parsed }).filter(([, value]) => value !== undefined),
  ) as unknown as IdentityPolicy
  const policy: IdentityPolicy = { ...DEFAULT_IDENTITY_POLICY, ...merged }
  const loosened = loosenedSettings(policy)
  if (loosened.length > 0 && !policy.riskTreatment) {
    throw new TypeError(`Identity policy loosens ${loosened.join(', ')} below the secure default without a riskTreatment reference.`)
  }
  return Object.freeze({
    ...policy,
    jurisdictions: Object.freeze([...policy.jurisdictions]),
    dataRegions: Object.freeze([...policy.dataRegions]),
    disposalParticipants: Object.freeze([...policy.disposalParticipants]),
  })
}
