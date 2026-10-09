import type {
  ApprovalRoute,
  GovernanceRequest,
  GroupDescription,
  GroupSettings,
  IdentityAccessDecision,
  IdentityApprovalPolicy,
  IdentityPermissionName,
  IdentityPolicy,
  IdentityRiskLevel,
  IdentitySubject,
  PendingChange,
} from '../../contracts'
import {
  DEFAULT_GROUP_SETTINGS,
  GOVERNANCE_CHANGES,
  IDENTITY_RISK_LEVELS,
  IdentityError,
  STEP_UP_REQUIREMENTS,
  approvalRequirement,
  checkSafeName,
  chooseRoute,
  confusableSkeleton,
  correlationIdSchema,
  governanceRequestSchema,
  groupDescriptionSchema,
  groupSettingsSchema,
  identifierSchema,
  identityPermissionRisk,
  identitySubjectSchema,
  meetsStepUp,
  pendingChangeSchema,
  refuseApproval,
  refuseRequest,
  sha256DigestSchema,
  wouldCreateCycle,
} from '../../contracts'
import type { Database, QueryClient } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. The approvals engine for governance changes (docs/contracts.md
 * §8; iam-integration `docs/processes/approvals.md`).
 *
 * A change is requested, authorised through the access-decision port,
 * checked against the rules (no self-grant, justification, step-up), routed
 * (approvers in the group, an owner of the parent group, an owner of the
 * tenant's root group, or a published delay) and recorded. With no approver
 * needed it applies at once. Otherwise it applies when enough qualifying
 * approvers agree, or when its published delay ends; it expires if nobody
 * decides in time. The database records, decides and applies through
 * SECURITY DEFINER functions that check every rule again, and every change
 * is announced through the outbox.
 *
 * Errors stay coarse (§12): an unknown target or change, or a caller who may
 * not see it, is `forbidden`; rules are reported (`conflict`) only to a
 * caller entitled to see the change.
 */

export interface ApprovalsDependencies {
  db: Database
  access: IdentityAccessDecision
  approvalPolicy: IdentityApprovalPolicy
  policy: IdentityPolicy
  clock?: Clock
}

interface Located {
  /** The group whose approvers decide, and on which the permission is checked. */
  governing: GroupDescription
  /** Further groups the requester must hold the permission on (a new parent). */
  alsoAuthoriseOn: string[]
  beneficiaryId: string | null
  createdId: string | null
  internal: Record<string, unknown>
  /** Rules checked once the requester is authorised; returns a conflict message, or null. */
  check: () => Promise<string | null>
}

interface MembershipFacts {
  membershipId: string
  identityId: string
  groupId: string
  tenantId: string
  groupKind: 'personal' | 'standard'
  groupState: 'active' | 'orphaned' | 'archived'
  state: 'active' | 'paused' | 'suspended' | 'ended'
  kind: 'member' | 'guest'
  owner: boolean
  otherActiveOwners: number
}

function parse<T>(run: () => T): T {
  try {
    return run()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

function higherRisk(a: IdentityRiskLevel, b: IdentityRiskLevel): IdentityRiskLevel {
  return IDENTITY_RISK_LEVELS.indexOf(a) >= IDENTITY_RISK_LEVELS.indexOf(b) ? a : b
}

/** Normalises a root group's name before the request is parsed, so the stored form is the safe one. */
function normaliseRequest(raw: unknown): unknown {
  const request = raw as { type?: unknown, target?: { name?: unknown } } | null
  if (request?.type !== 'group.create-root' || typeof request.target?.name !== 'string') return raw
  const name = checkSafeName(request.target.name)
  if (!name.ok) throw new IdentityError('validation-failed', name.problem)
  return { ...request, target: { ...request.target, name: name.value } }
}

export function createApprovals({ db, access, approvalPolicy, policy, clock = systemClock }: ApprovalsDependencies) {
  async function port<T>(run: () => Promise<T>, what: string): Promise<T> {
    try {
      return await run()
    }
    catch {
      throw new IdentityError('unavailable', `${what} failed`)
    }
  }

  async function authorise(subject: IdentitySubject, permission: IdentityPermissionName, groupId: string, correlationId: string): Promise<void> {
    const decision = await port(() => access.decide({ subject, permission, groupId, correlationId }), 'access decision')
    if (decision.allowed) return
    throw new IdentityError(decision.reason === 'insufficient-assurance' ? 'insufficient-assurance' : 'forbidden')
  }

  async function signInState(client: QueryClient, identityId: string): Promise<{ kind: string, state: string } | null> {
    const { rows } = await client.query<{ result: { kind: string, state: string } | null }>(`select ${db.schema}.sign_in_status($1) as result`, [identityId])
    return rows[0]?.result ?? null
  }

  /** Only an active person requests or approves governance changes. */
  async function requireActivePerson(subject: IdentitySubject): Promise<void> {
    const status = await db.transaction(client => signInState(client, subject.principalId))
    if (status?.kind !== 'person' || status.state !== 'active') throw new IdentityError('forbidden')
  }

  async function describe(groupId: string): Promise<GroupDescription | null> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.describe_group($1) as result`, [groupId]))
    return rows[0]?.result ? groupDescriptionSchema.parse(rows[0].result) : null
  }

  async function standardGroup(groupId: string): Promise<GroupDescription> {
    const group = await describe(groupId)
    if (!group || group.kind !== 'standard') throw new IdentityError('forbidden')
    return group
  }

  async function settingsOf(group: GroupDescription): Promise<GroupSettings> {
    const { rows } = await db.transaction(
      client => client.query<{ settings: unknown }>(`select settings from ${db.schema}."group" where group_id = $1`, [group.groupId]),
      { tenantIds: [group.tenantId] },
    )
    return groupSettingsSchema.parse(rows[0]?.settings)
  }

  async function membership(membershipId: string): Promise<MembershipFacts> {
    const { rows } = await db.transaction(client => client.query<{ result: MembershipFacts | null }>(
      `select ${db.schema}.locate_membership($1) as result`,
      [membershipId],
    ))
    const found = rows[0]?.result
    if (!found || found.groupKind !== 'standard') throw new IdentityError('forbidden')
    return found
  }

  async function newIdentifier(): Promise<string> {
    const { rows } = await db.transaction(client => client.query<{ id: string }>(`select ${db.schema}.uuid_v7()::text as id`))
    return rows[0]!.id
  }

  async function platformGroup(): Promise<GroupDescription> {
    if (!policy.platformGroupId) throw new IdentityError('forbidden', 'no platform group is configured')
    return standardGroup(policy.platformGroupId)
  }

  async function countOwners(groupId: string, excluding: string[]): Promise<number> {
    const { rows } = await db.transaction(client => client.query<{ n: number }>(
      `select ${db.schema}.count_active_owners($1, $2::uuid[]) as n`,
      [groupId, excluding],
    ), { at: clock.now() })
    return rows[0]!.n
  }

  async function isOwner(identityId: string, groupId: string): Promise<boolean> {
    const { rows } = await db.transaction(client => client.query<{ owner: boolean }>(
      `select ${db.schema}.is_active_owner($1, $2) as owner`,
      [identityId, groupId],
    ), { at: clock.now() })
    return rows[0]!.owner === true
  }

  /** Finds what the change acts on. Anything unknown is `forbidden`, before any authorisation is asked. */
  async function locate(request: GovernanceRequest, requesterId: string): Promise<Located> {
    switch (request.type) {
      case 'group.create-root': {
        const governing = await platformGroup()
        const { tenantId, name, firstOwnerId } = request.target
        const skeleton = confusableSkeleton(name)
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: firstOwnerId,
          createdId: await newIdentifier(),
          internal: { nameSkeleton: skeleton, settings: DEFAULT_GROUP_SETTINGS },
          check: async () => {
            const facts = await db.transaction(async (client) => {
              const tenant = await client.query<{ state: string }>(`select state from ${db.schema}.tenant where tenant_id = $1`, [tenantId])
              const sibling = await client.query(
                `select 1 from ${db.schema}."group" where tenant_id = $1 and parent_group_id is null and name_skeleton = $2`,
                [tenantId, skeleton],
              )
              return { tenant: tenant.rows[0]?.state ?? null, confusable: sibling.rows.length > 0, owner: await signInState(client, firstOwnerId) }
            }, { tenantIds: [tenantId] })
            if (facts.tenant !== 'active') return 'tenant is not active'
            if (facts.owner?.kind !== 'person' || facts.owner.state !== 'active') return 'first owner must be an active person'
            if (facts.confusable) return 'a root group with a confusable name exists'
            return null
          },
        }
      }
      case 'group.reparent': {
        const governing = await standardGroup(request.target.groupId)
        const parent = await standardGroup(request.target.parentGroupId)
        return {
          governing,
          alsoAuthoriseOn: [parent.groupId],
          beneficiaryId: null,
          createdId: null,
          internal: { maxDepth: policy.maxHierarchyDepth },
          check: async () => {
            if (parent.tenantId !== governing.tenantId) return 'groups are in different tenants'
            if (governing.state !== 'active' || parent.state !== 'active') return 'group is not active'
            if (wouldCreateCycle(governing.groupId, parent.lineage)) return 'would create a cycle'
            if (governing.lineage.at(-2) === parent.groupId) return 'already under that parent'
            if (parent.lineage.length + 1 > policy.maxHierarchyDepth) return 'hierarchy too deep'
            return null
          },
        }
      }
      case 'group.archive':
      case 'service-identity.create': {
        const governing = await standardGroup(request.target.groupId)
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: null,
          createdId: request.type === 'service-identity.create' ? await newIdentifier() : null,
          internal: {},
          check: async () => (governing.state === 'active' ? null : 'group is not active'),
        }
      }
      case 'group.change-settings': {
        const governing = await standardGroup(request.target.groupId)
        const { approvals: _approvals, ...base } = await settingsOf(governing)
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: null,
          createdId: null,
          internal: { baseSettings: base },
          check: async () => {
            if (governing.state !== 'active') return 'group is not active'
            if (request.target.settings.guests.termDays > policy.guestTermDays) return 'guest term exceeds the policy'
            return null
          },
        }
      }
      case 'group.change-approvals': {
        const governing = await standardGroup(request.target.groupId)
        const current = await settingsOf(governing)
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: null,
          createdId: null,
          internal: { baseApprovals: current.approvals },
          check: async () => (governing.state === 'active' ? null : 'group is not active'),
        }
      }
      case 'group.add-owner':
      case 'group.remove-owner':
      case 'group.suspend-owner':
      case 'membership.reinstate':
      case 'membership.schedule': {
        const facts = await membership(request.target.membershipId)
        const governing = await standardGroup(facts.groupId)
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: facts.identityId,
          createdId: null,
          internal: request.type === 'membership.schedule' ? { guestTermDays: policy.guestTermDays } : {},
          check: async () => {
            if (facts.groupState !== 'active') return 'group is not active'
            if (facts.state === 'ended') return 'membership has ended'
            switch (request.type) {
              case 'group.add-owner':
                if (facts.owner) return 'already an owner'
                if (facts.kind !== 'member' || facts.state !== 'active') return 'only an active member can become an owner'
                return null
              case 'group.remove-owner':
              case 'group.suspend-owner':
                if (!facts.owner) return 'not an owner'
                if (facts.otherActiveOwners < 1) return 'last-owner'
                if (request.type === 'group.suspend-owner' && facts.identityId === requesterId) return 'act on yourself by leaving or pausing'
                if (request.type === 'group.suspend-owner' && facts.state === 'suspended') return 'membership is already suspended'
                return null
              case 'membership.reinstate':
                return facts.state === 'suspended' ? null : 'membership is not suspended'
              default:
                return null
            }
          },
        }
      }
      case 'identity.suspend':
      case 'identity.reinstate': {
        const governing = await platformGroup()
        const { identityId } = request.target
        return {
          governing,
          alsoAuthoriseOn: [],
          beneficiaryId: identityId,
          createdId: null,
          internal: {},
          check: async () => {
            const status = await db.transaction(client => signInState(client, identityId))
            if (!status || (status.kind !== 'person' && status.kind !== 'service')) return 'identity cannot be suspended'
            if (identityId === requesterId) return 'act on yourself by pausing or closing'
            if (request.type === 'identity.suspend' && status.state !== 'active' && status.state !== 'paused') return 'identity is not active or paused'
            if (request.type === 'identity.reinstate' && status.state !== 'suspended') return 'identity is not suspended'
            return null
          },
        }
      }
    }
  }

  async function routeFor(input: {
    permission: IdentityPermissionName
    governing: GroupDescription
    approvers: 0 | 1 | 2
    requesterId: string
    beneficiaryId: string | null
  }): Promise<ApprovalRoute> {
    if (input.approvers === 0) return 'none'
    const { permission, governing, requesterId, beneficiaryId } = input
    let qualifying = await port(() => approvalPolicy.countQualifying({ permission, groupId: governing.groupId, excludingId: requesterId, limit: input.approvers + 1 }), 'approval policy')
    if (beneficiaryId && beneficiaryId !== requesterId && qualifying > 0
      && await port(() => approvalPolicy.qualifies({ approverId: beneficiaryId, permission, groupId: governing.groupId }), 'approval policy')) {
      qualifying -= 1
    }
    const excluding = [requesterId, ...(beneficiaryId ? [beneficiaryId] : [])]
    const { lineage } = governing
    // A root group has no parent, and is itself the tenant's root: its own owners count as qualifying already.
    const parentOwners = lineage.length > 1 ? await countOwners(lineage.at(-2)!, excluding) : 0
    const tenantOwners = lineage.length > 2 ? await countOwners(lineage[0]!, excluding) : 0
    return chooseRoute({ approvers: input.approvers, qualifyingInGroup: qualifying, parentOwners, tenantOwners })
  }

  /** Whether `approverId` may decide `change` now, by its route. Asked of Authorisation with a strong read. */
  async function qualifiesFor(change: PendingChange, approverId: string): Promise<boolean> {
    if (change.groupId === null) return false
    const permission = GOVERNANCE_CHANGES[change.type].permission
    switch (change.route) {
      case 'approvers':
        return port(() => approvalPolicy.qualifies({ approverId, permission, groupId: change.groupId! }), 'approval policy')
      case 'parent-owner':
      case 'tenant-owner': {
        const group = await describe(change.groupId)
        if (!group) return false
        const owners = change.route === 'parent-owner' ? group.lineage.at(-2) : group.lineage[0]
        return owners !== undefined && owners !== group.groupId ? isOwner(approverId, owners) : false
      }
      default:
        return false
    }
  }

  async function load(changeId: string): Promise<PendingChange | null> {
    const { rows } = await db.transaction(client => client.query<{ result: unknown }>(`select ${db.schema}.get_change($1) as result`, [changeId]))
    return rows[0]?.result ? pendingChangeSchema.parse(rows[0].result) : null
  }

  return {
    /**
     * Requests a governance change. Returns the recorded change: `applied`
     * when no approver is needed, `awaiting-approval`, or `delayed` (a
     * published delay when nobody can approve).
     */
    async request(input: { subject: IdentitySubject, request: unknown, correlationId: string }): Promise<PendingChange> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const request = parse(() => governanceRequestSchema.parse(normaliseRequest(input.request))) as GovernanceRequest
      const located = await locate(request, subject.principalId)
      const permission = GOVERNANCE_CHANGES[request.type].permission
      await authorise(subject, permission, located.governing.groupId, correlationId)
      for (const groupId of located.alsoAuthoriseOn) await authorise(subject, permission, groupId, correlationId)
      await requireActivePerson(subject)

      const refusal = refuseRequest({
        type: request.type,
        requesterId: subject.principalId,
        beneficiaryId: located.beneficiaryId,
        inRequestersPersonalGroup: false,
        reasonCode: request.justification.reasonCode,
        reference: request.justification.reference,
        referenceRequired: false,
      })
      if (refusal === 'self-grant') throw new IdentityError('conflict', refusal)
      const problem = await located.check()
      if (problem) throw new IdentityError('conflict', problem)

      const settings = await settingsOf(located.governing)
      if (settings.approvals.referenceRequired && !request.justification.reference) throw new IdentityError('validation-failed', 'reference-missing')
      const catalogued = await port(() => approvalPolicy.riskOf(permission), 'approval policy')
      if (!catalogued) throw new IdentityError('unavailable', `${permission} is missing from the host's catalogue`)
      const risk = higherRisk(identityPermissionRisk(permission), catalogued)
      const now = clock.now()
      if (!meetsStepUp({ level: subject.assurance.level, phishingResistant: subject.assurance.phishingResistant, authenticatedAt: subject.authenticatedAt }, STEP_UP_REQUIREMENTS[risk], now)) {
        throw new IdentityError('insufficient-assurance')
      }

      const requirement = approvalRequirement({ risk, inRequestersPersonalGroup: false, groupRequirement: settings.approvals.required })
      const route = await routeFor({ permission, governing: located.governing, approvers: requirement.approvers, requesterId: subject.principalId, beneficiaryId: located.beneficiaryId })
      const hours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString()
      const record = {
        type: request.type,
        groupId: located.governing.groupId,
        requesterId: subject.principalId,
        beneficiaryId: located.beneficiaryId,
        risk,
        reasonCode: request.justification.reasonCode,
        reference: request.justification.reference,
        target: request.target,
        createdId: located.createdId,
        internal: located.internal,
        requiredApprovals: route === 'parent-owner' || route === 'tenant-owner' ? 1 : requirement.approvers,
        route,
        delayEndsAt: route === 'published-delay' ? hours(risk === 'critical' ? policy.publishedDelayCriticalHours : policy.publishedDelayHighHours) : null,
        expiresAt: ['approvers', 'parent-owner', 'tenant-owner'].includes(route) ? hours(policy.approvalExpiryDays * 24) : null,
        correlationId,
        at: now.toISOString(),
      }
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(`select ${db.schema}.record_change($1::jsonb) as result`, [JSON.stringify(record)]),
        { tenantIds: [located.governing.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      return pendingChangeSchema.parse(rows[0]!.result)
    },

    /**
     * An approver approves or rejects a change, quoting the digest of the
     * change they were shown. Returns the change as it now stands: still
     * `awaiting-approval`, `applied`, `rejected` (by the approver, or because
     * a rule no longer held when it was applied), or `expired`.
     */
    async decide(input: { subject: IdentitySubject, changeId: string, changeDigest: string, decision: 'approve' | 'reject', correlationId: string }): Promise<PendingChange> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const changeId = parse(() => identifierSchema.parse(input.changeId))
      const digest = parse(() => sha256DigestSchema.parse(input.changeDigest))
      if (input.decision !== 'approve' && input.decision !== 'reject') throw new IdentityError('validation-failed')
      const change = await load(changeId)
      if (!change) throw new IdentityError('forbidden')
      const involved = change.requesterId === subject.principalId || change.beneficiaryId === subject.principalId
      if (!involved && !(await qualifiesFor(change, subject.principalId))) throw new IdentityError('forbidden')
      await requireActivePerson(subject)
      const now = clock.now()
      const assurance = { level: subject.assurance.level, phishingResistant: subject.assurance.phishingResistant, authenticatedAt: subject.authenticatedAt }
      const refusal = refuseApproval({ change, approverId: subject.principalId, qualifies: true, controlledByRequester: false, assurance, changeDigest: digest, now })
      if (refusal === 'insufficient-assurance') throw new IdentityError('insufficient-assurance')
      if (refusal) throw new IdentityError('conflict', refusal)
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(
          `select ${db.schema}.record_decision($1, $2, $3, $4::jsonb, $5, $6) as result`,
          [changeId, subject.principalId, input.decision, JSON.stringify(assurance), digest, now],
        ),
        { tenantIds: [change.tenantId], actorId: subject.principalId, correlationId, at: now },
      )
      return pendingChangeSchema.parse(rows[0]!.result)
    },

    /** The requester withdraws a change that has not yet taken effect. */
    async cancel(input: { subject: IdentitySubject, changeId: string, correlationId: string }): Promise<PendingChange> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const correlationId = parse(() => correlationIdSchema.parse(input.correlationId))
      const changeId = parse(() => identifierSchema.parse(input.changeId))
      const now = clock.now()
      const { rows } = await db.transaction(
        client => client.query<{ result: unknown }>(`select ${db.schema}.cancel_change($1, $2, $3) as result`, [changeId, subject.principalId, now]),
        { actorId: subject.principalId, correlationId, at: now },
      )
      return pendingChangeSchema.parse(rows[0]!.result)
    },

    /** A change, for its requester, its beneficiary, or someone who may decide it. Anyone else: `forbidden`. */
    async getPendingChange(input: { subject: IdentitySubject, changeId: string }): Promise<PendingChange> {
      const subject = parse(() => identitySubjectSchema.parse(input.subject))
      const changeId = parse(() => identifierSchema.parse(input.changeId))
      const change = await load(changeId)
      if (!change) throw new IdentityError('forbidden')
      if (change.requesterId === subject.principalId || change.beneficiaryId === subject.principalId) return change
      if (await qualifiesFor(change, subject.principalId)) return change
      throw new IdentityError('forbidden')
    },
  }
}

export type Approvals = ReturnType<typeof createApprovals>
