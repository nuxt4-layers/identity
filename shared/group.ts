import { z } from 'zod'
import { externalIdSchema, identifierSchema, instantSchema, reasonCodeSchema, versionSchema } from './identifiers'
import { storedSafeNameSchema } from './safe-names'

/**
 * Groups and their governance settings (docs/contracts.md §5).
 *
 * A group owns information and has members. Each has zero or one parent in
 * the same tenant; the hierarchy is organisational only and confers no
 * access (Group Model Definition §3, §6).
 */

/** `personal` — the unary group of one person. `standard` — every other group. */
export const GROUP_KINDS = ['personal', 'standard'] as const
export type GroupKind = typeof GROUP_KINDS[number]

/**
 * - `active` — at least one active owner.
 * - `orphaned` — no active owner; governed only through recovery.
 * - `archived` — read-only; no new memberships.
 * Personal groups are never orphaned or archived on their own.
 */
export const GROUP_STATES = ['active', 'orphaned', 'archived'] as const
export type GroupState = typeof GROUP_STATES[number]

// ---------------------------------------------------------------------------
// Departure data policy (ADR-0005 §2.7; iam-integration joining and leaving)
// ---------------------------------------------------------------------------

/** What fellow members see on a leaver's past contributions. */
export const DEPARTURE_ATTRIBUTIONS = ['keep-name', 'pseudonymise', 'anonymise'] as const
/** Whether a leaver appears in the group's member history, and to whom. */
export const HISTORY_VISIBILITIES = ['all-members', 'administrators', 'nobody'] as const
/**
 * What happens when a leaver asks for deletion, within the law:
 * - `anonymise` — attribution is unlinked; contributions stay (the floor, always available to the leaver);
 * - `erase-where-lawful` — domain capabilities erase the leaver's contributions unless a retention reason applies;
 * - `review` — an administrator decides each request within the jurisdiction's deadline.
 */
export const DELETION_REQUEST_HANDLING = ['anonymise', 'erase-where-lawful', 'review'] as const

export const departurePolicySchema = z.strictObject({
  attribution: z.enum(DEPARTURE_ATTRIBUTIONS),
  historyVisibility: z.enum(HISTORY_VISIBILITIES),
  deletionRequests: z.enum(DELETION_REQUEST_HANDLING),
  /** Why the group must keep information (legal or contractual retention), as reason codes. */
  retentionReasons: z.array(reasonCodeSchema).max(16),
})

export type DeparturePolicy = z.infer<typeof departurePolicySchema>

export const DEFAULT_DEPARTURE_POLICY: DeparturePolicy = Object.freeze({
  attribution: 'keep-name',
  historyVisibility: 'administrators',
  deletionRequests: 'anonymise',
  retentionReasons: Object.freeze([]) as unknown as string[],
})

// ---------------------------------------------------------------------------
// Other settings
// ---------------------------------------------------------------------------

/**
 * The group's pause setting, reserved with one value in contract 1. A later
 * release MAY add `notice` and `approval`. No value can prevent a person
 * pausing their whole identity (ADR-0005 §2.6).
 */
export const PAUSE_SETTINGS = ['allowed'] as const

/**
 * Approvers required beyond the person making a change, by risk. The
 * defaults are the floor (iam-integration approvals): a group may raise any
 * of them, never lower one. Raising is itself a `critical` change.
 */
export const DEFAULT_REQUIRED_APPROVERS = Object.freeze({ low: 0, medium: 0, high: 1, critical: 1 } as const)

export const requiredApproversSchema = z.strictObject({
  low: z.union([z.literal(0), z.literal(1)]),
  medium: z.union([z.literal(0), z.literal(1)]),
  high: z.union([z.literal(1), z.literal(2)]),
  critical: z.union([z.literal(1), z.literal(2)]),
})

export type RequiredApprovers = z.infer<typeof requiredApproversSchema>

export const groupSettingsSchema = z.strictObject({
  joining: z.strictObject({
    /** Members may ask to join; an administrator decides. */
    requests: z.boolean(),
    /** Anyone in the tenant may join without approval. Off by default. */
    open: z.boolean(),
  }),
  pausing: z.enum(PAUSE_SETTINGS),
  guests: z.strictObject({
    allowed: z.boolean(),
    /** Length of a guest membership before renewal, in days. At most the policy's `guestTermDays`. */
    termDays: z.number().int().min(1).max(365),
  }),
  approvals: z.strictObject({
    required: requiredApproversSchema,
    /** Whether a governance change must carry a justification reference as well as a reason code. */
    referenceRequired: z.boolean(),
  }),
  /** On archiving: memberships end, or remain read-only. */
  onArchive: z.enum(['end-memberships', 'read-only']),
  departure: departurePolicySchema,
})

export type GroupSettings = z.infer<typeof groupSettingsSchema>

export const DEFAULT_GROUP_SETTINGS: GroupSettings = Object.freeze({
  joining: { requests: true, open: false },
  pausing: 'allowed',
  guests: { allowed: true, termDays: 90 },
  approvals: { required: { ...DEFAULT_REQUIRED_APPROVERS }, referenceRequired: false },
  onArchive: 'read-only',
  departure: DEFAULT_DEPARTURE_POLICY,
}) as GroupSettings

/** True when `next` lowers any requirement below the default floor. */
export function lowersBelowFloor(next: RequiredApprovers): boolean {
  return (Object.keys(DEFAULT_REQUIRED_APPROVERS) as (keyof RequiredApprovers)[])
    .some(risk => next[risk] < DEFAULT_REQUIRED_APPROVERS[risk])
}

// ---------------------------------------------------------------------------
// The group record
// ---------------------------------------------------------------------------

export const groupSchema = z.strictObject({
  groupId: identifierSchema,
  tenantId: identifierSchema,
  kind: z.enum(GROUP_KINDS),
  /** Null for a root group and for every personal group. */
  parentGroupId: identifierSchema.nullable(),
  /** A safe name. Null for a personal group, which Profile presents by its person. */
  name: storedSafeNameSchema.nullable(),
  externalId: externalIdSchema.nullable(),
  state: z.enum(GROUP_STATES),
  /** Null for a personal group: its person is sovereign and needs no settings. */
  settings: groupSettingsSchema.nullable(),
  createdAt: instantSchema,
  version: versionSchema,
}).superRefine((group, context) => {
  const personal = group.kind === 'personal'
  if (personal && (group.parentGroupId !== null || group.name !== null || group.settings !== null || group.state !== 'active')) {
    context.addIssue({ code: 'custom', message: 'A personal group has no parent, name or settings, and is always active' })
  }
  if (!personal && (group.name === null || group.settings === null)) {
    context.addIssue({ code: 'custom', message: 'A standard group has a name and settings' })
  }
})

export type GroupRecord = z.infer<typeof groupSchema>

/**
 * Where a group sits: its ancestors from the root down to the group itself.
 * Every group has at most one parent, so this is a single chain within one
 * tenant. Its length never exceeds the policy's `maxHierarchyDepth`.
 */
export const lineageSchema = z.array(identifierSchema).min(1).max(32)

/** True when moving `groupId` under `newParentLineage` would make it its own ancestor. */
export function wouldCreateCycle(groupId: string, newParentLineage: readonly string[]): boolean {
  return newParentLineage.includes(groupId)
}
