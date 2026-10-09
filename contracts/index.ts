/**
 * Public contract for the `@nuxt4-layers/identity` capability, version 1.
 *
 * This module is the only supported cross-layer import path for the layer's
 * types, schemas and pure helpers. It imports nothing but zod: no Nuxt, Vue,
 * h3, server code, driver or other capability's package.
 *
 * Identity holds no personal data. Every record, event and port answer it
 * publishes is listed in `IDENTITY_DATA_SCHEMAS`, and
 * `tests/personal-data.test.ts` proves that none of them can carry any.
 */

import type { z } from 'zod'
import { breakGlassReviewSchema } from '../shared/break-glass'
import { groupMembersPageSchema, groupViewSchema, identityExportSchema, selfViewSchema } from '../shared/administration'
import { actorContextSchema, groupDescriptionSchema } from '../shared/directory'
import { disclosureContextSchema } from '../shared/disclosure'
import { identityEventSchema } from '../shared/events'
import { groupSchema } from '../shared/group'
import { identityExternalIdSchema, identitySchema } from '../shared/identity'
import { invitationSchema } from '../shared/invitation'
import { joinRequestSchema } from '../shared/join-request'
import { membershipSchema } from '../shared/membership'
import { pendingChangeSchema } from '../shared/approvals'
import { provisionedIdentitySchema, provisioningReservationSchema, signInStatusSchema } from '../shared/provisioning'
import { scimGroupStructureSchema, scimUserStructureSchema } from '../shared/scim'
import { tenantSchema } from '../shared/tenant'

// Identifiers and codes
export type { CorrelationId, Identifier, Instant, ReasonCode } from '../shared/identifiers'
export {
  EXTERNAL_ID_PATTERN,
  REASON_CODE_PATTERN,
  UUID_PATTERN,
  UUID_V7_PATTERN,
  correlationIdSchema,
  externalIdSchema,
  identifierSchema,
  instantSchema,
  justificationReferenceSchema,
  reasonCodeSchema,
  registryCodeSchema,
  sha256DigestSchema,
  versionSchema,
} from '../shared/identifiers'

// Safe names (improvement register item 6)
export type { SafeNameProblem, SafeNameResult } from '../shared/safe-names'
export {
  SAFE_NAME_MAX_LENGTH,
  SAFE_NAME_PROBLEMS,
  checkSafeName,
  confusableSkeleton,
  safeGroupNameSchema,
  scriptsOf,
  storedSafeNameSchema,
} from '../shared/safe-names'

// Identities
export type { IdentityAction, IdentityActor, IdentityExternalId, IdentityKind, IdentityRecord, IdentityState, IdentityTransition } from '../shared/identity'
export {
  IDENTITY_ACTORS,
  IDENTITY_KINDS,
  IDENTITY_STATES,
  IDENTITY_TRANSITIONS,
  REAUTHENTICATION_MAX_AGE_SECONDS,
  SIGN_IN_STATES,
  identityExternalIdSchema,
  identitySchema,
  identityTransition,
} from '../shared/identity'

// Tenancy (its own module, extractable to a tenancy capability)
export type { TenantRecord, TenantState } from '../shared/tenant'
export { TENANT_STATES, tenantSchema } from '../shared/tenant'

// Groups, settings and the departure data policy
export type { DeparturePolicy, GroupKind, GroupRecord, GroupSettings, GroupState, RequiredApprovers } from '../shared/group'
export {
  DEFAULT_DEPARTURE_POLICY,
  DEFAULT_GROUP_SETTINGS,
  DEFAULT_REQUIRED_APPROVERS,
  DELETION_REQUEST_HANDLING,
  DEPARTURE_ATTRIBUTIONS,
  GROUP_KINDS,
  GROUP_STATES,
  HISTORY_VISIBILITIES,
  INVITATION_ACCEPTANCE_MODES,
  PAUSE_SETTINGS,
  departurePolicySchema,
  groupSchema,
  groupSettingsSchema,
  lineageSchema,
  lowersBelowFloor,
  requiredApproversSchema,
  wouldCreateCycle,
} from '../shared/group'

// Memberships
export type { EffectiveStatus, MembershipEndReason, MembershipKind, MembershipRecord, MembershipState } from '../shared/membership'
export {
  EFFECTIVE_STATUSES,
  MEMBERSHIP_END_REASONS,
  MEMBERSHIP_KINDS,
  MEMBERSHIP_STATES,
  MEMBERSHIP_TRANSITIONS,
  effectiveStatus,
  membershipSchema,
  refusedByGovernance,
} from '../shared/membership'

// Invitations (improvement register item 20)
export type { ConfirmationRefusal, InvitationRecord, InvitationState } from '../shared/invitation'
export {
  CONFIRMATION_REFUSALS,
  INVITATION_ACKNOWLEDGEMENT,
  INVITATION_STATES,
  INVITATION_TOKEN_BYTES,
  invitationRequiresConfirmation,
  invitationSchema,
  invitationTokenSchema,
  refuseConfirmation,
} from '../shared/invitation'

// Join requests
export type { JoinDecisionRefusal, JoinRequestRecord, JoinRequestState } from '../shared/join-request'
export { JOIN_DECISION_REFUSALS, JOIN_REQUEST_STATES, joinRequestSchema, refuseJoinDecision } from '../shared/join-request'

// Permissions
export type { IdentityPermissionDefinition, IdentityPermissionEffect, IdentityPermissionName, IdentityRiskLevel } from '../shared/permissions'
export { IDENTITY_PERMISSION_EFFECTS, IDENTITY_PERMISSIONS, IDENTITY_RISK_LEVELS, identityPermissionRisk } from '../shared/permissions'

// Governance approvals
export type {
  ApprovalRefusal,
  ApprovalRequirement,
  ApprovalRoute,
  GovernanceChangeType,
  GovernanceRequest,
  GovernanceTarget,
  PendingChange,
  PendingChangeState,
  RequestRefusal,
  RequestableChangeType,
  StepUpRequirement,
} from '../shared/approvals'
export {
  APPROVAL_REFUSALS,
  APPROVAL_ROUTES,
  GOVERNANCE_CHANGES,
  GOVERNANCE_CHANGE_TYPES,
  GOVERNANCE_TARGETS,
  PENDING_CHANGE_STATES,
  REQUESTABLE_CHANGE_TYPES,
  REQUEST_REFUSALS,
  STEP_UP_REQUIREMENTS,
  approvalRecordSchema,
  approvalRequirement,
  assuranceRecordSchema,
  chooseRoute,
  governanceRequestSchema,
  governanceTargetSchema,
  justificationSchema,
  meetsStepUp,
  pendingChangeSchema,
  refuseApproval,
  refuseRequest,
} from '../shared/approvals'

// Break-glass (ADR-0007)
export type { BreakGlassAction, BreakGlassRefusal, BreakGlassReview } from '../shared/break-glass'
export { BREAK_GLASS_ACTIONS, BREAK_GLASS_REFUSALS, breakGlassReviewSchema, mayCloseReview, refuseBreakGlass } from '../shared/break-glass'

// Provided ports: provisioning, directory, disclosure context
export type { IdentityProvisioning, SignInStatus } from '../shared/provisioning'
export {
  SIGN_IN_OUTCOMES,
  provisionedIdentitySchema,
  provisioningConfirmInputSchema,
  provisioningReservationSchema,
  provisioningReserveInputSchema,
  signInOutcome,
  signInStatusSchema,
} from '../shared/provisioning'
export type { ActorContext, DirectoryConsistency, DirectoryMembership, DirectoryReadOptions, GroupDescription, IdentityDirectory } from '../shared/directory'
export {
  DIRECTORY_CONSISTENCIES,
  IDENTITY_MAX_STALENESS_SECONDS,
  actorContextSchema,
  directoryMembershipSchema,
  groupDescriptionSchema,
} from '../shared/directory'
export type { DisclosureContext, DisclosureRequest, IdentityDisclosureContextPort, Relationship } from '../shared/disclosure'
export {
  DISCLOSURE_MAX_SUBJECTS,
  RELATIONSHIPS,
  SUBJECT_STANDINGS,
  disclosureContextSchema,
  disclosureRequestSchema,
  disclosureSubjectSchema,
  standingOf,
} from '../shared/disclosure'

// Administration (HTTP endpoints and read functions)
export type { GroupMember, GroupMembersPage, GroupView, IdentityExport, IdentitySubjectResolver, SelfView } from '../shared/administration'
export {
  IDENTITY_API_PREFIX,
  IDENTITY_CORRELATION_HEADER,
  groupMemberSchema,
  groupMembersPageSchema,
  groupViewSchema,
  identityExportSchema,
  selfViewSchema,
} from '../shared/administration'

// Consumed ports
export type {
  AccessDecision,
  IdentityAccessDecision,
  IdentityApprovalPolicy,
  IdentityDatabase,
  IdentityEventPublisher,
  IdentitySubject,
  PostgresPoolLike,
} from '../shared/ports'
export { identitySubjectSchema } from '../shared/ports'

// Events
export type { IdentityEvent, IdentityEventType } from '../shared/events'
export {
  AUTHENTICATION_CONSUMED_EVENT_TYPES,
  IDENTITY_AGGREGATE_TYPES,
  IDENTITY_EVENT_PAYLOADS,
  IDENTITY_EVENT_TYPES,
  PROFILE_CONSUMED_EVENT_TYPES,
  identityEventSchema,
} from '../shared/events'

// SCIM structure (improvement register item 5)
export { SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA, scimActive, scimGroupStructureSchema, scimUserStructureSchema, scimVersion } from '../shared/scim'

// Errors
export type { IdentityErrorBody, IdentityErrorCode } from '../shared/errors'
export { IDENTITY_ERROR_CODES, IDENTITY_ERROR_STATUS, IdentityCompositionError, IdentityError, isIdentityErrorCode } from '../shared/errors'

// Policy
export type { IdentityPolicy, IdentityPolicyInput, IdentityPolicyPeriods, IdentityPolicySetting } from '../shared/policy'
export { DEFAULT_IDENTITY_POLICY, IDENTITY_POLICY_BOUNDS, identityPolicyInputSchema, loosenedSettings, resolveIdentityPolicy } from '../shared/policy'
export type { EffectiveSafetyPeriods, SafetyPeriodLevels, SafetyPeriodRefusal, SafetyPeriods, SafetyPeriodSetting } from '../shared/safety-periods'
export {
  PLATFORM_ONLY_SAFETY_PERIODS,
  SAFETY_PERIOD_REFUSALS,
  SAFETY_PERIOD_SETTINGS,
  effectiveSafetyPeriods,
  effectiveSafetyPeriodsSchema,
  lessSafe,
  platformSafetyPeriods,
  refuseSafetyPeriods,
  safetyPeriodsSchema,
  saferValue,
  waitOutHours,
} from '../shared/safety-periods'

/**
 * Every record Identity stores, every event it publishes and every answer
 * its ports give. Adding one here brings it under the personal-data contract
 * test; a schema that crosses Identity's boundary and is missing here fails
 * review.
 */
export const IDENTITY_DATA_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.freeze({
  identity: identitySchema,
  identityExternalId: identityExternalIdSchema,
  tenant: tenantSchema,
  group: groupSchema,
  membership: membershipSchema,
  invitation: invitationSchema,
  joinRequest: joinRequestSchema,
  pendingChange: pendingChangeSchema,
  breakGlassReview: breakGlassReviewSchema,
  event: identityEventSchema,
  provisioningReservation: provisioningReservationSchema,
  provisionedIdentity: provisionedIdentitySchema,
  signInStatus: signInStatusSchema,
  actorContext: actorContextSchema,
  groupDescription: groupDescriptionSchema,
  disclosureContext: disclosureContextSchema,
  scimUserStructure: scimUserStructureSchema,
  scimGroupStructure: scimGroupStructureSchema,
  selfView: selfViewSchema,
  groupView: groupViewSchema,
  groupMembersPage: groupMembersPageSchema,
  identityExport: identityExportSchema,
})
