import type { DisclosureContext, IdentityDisclosureContextPort, IdentityState, Relationship } from '../../contracts'
import { disclosureContextSchema, disclosureRequestSchema, effectiveStatus, IdentityError, standingOf } from '../../contracts'
import type { Database } from './database'
import type { Clock } from './provisioning'
import { systemClock } from './provisioning'

/**
 * PRIVATE. The disclosure-context port (docs/contracts.md §10.3). The
 * database returns raw facts limited to the viewer's own groups and tenants
 * (and the group context); the relationships are computed here with the
 * same effective-status rules as the directory. Profile records the
 * leaver's own anonymisation choice; Identity supplies only facts.
 */

interface FactMembership { groupId: string, tenantId: string, state: 'active' | 'paused' | 'suspended' | 'ended', startsAt: string, endsAt: string | null }
interface SubjectMembership extends FactMembership { kind: 'member' | 'guest', endedAt: string | null }
interface Facts {
  viewerState: IdentityState | null
  viewer: FactMembership[]
  departurePolicy: DisclosureContext['departurePolicy']
  subjects: { subjectId: string, state: IdentityState | null, memberships: SubjectMembership[] }[]
}

const IN_EFFECT = new Set(['active', 'paused', 'suspended'])

export function createDisclosure(db: Database, clock: Clock = systemClock): IdentityDisclosureContextPort {
  return {
    async describe(request) {
      let parsed
      try {
        parsed = disclosureRequestSchema.parse(request)
      }
      catch {
        throw new IdentityError('validation-failed')
      }
      const { rows } = await db.transaction(client => client.query<{ result: Facts }>(
        `select ${db.schema}.disclosure_facts($1, $2::uuid[], $3) as result`,
        [parsed.viewerId, parsed.subjectIds, parsed.groupId],
      ))
      const facts = rows[0]!.result
      const now = clock.now()
      const inEffect = (membership: FactMembership, identityState: IdentityState | null) =>
        identityState !== null && IN_EFFECT.has(effectiveStatus(membership, identityState, now))

      const viewerMemberships = facts.viewer.filter(membership => inEffect(membership, facts.viewerState))
      const viewerGroups = new Set(viewerMemberships.map(membership => membership.groupId))
      const viewerTenants = new Set(viewerMemberships.map(membership => membership.tenantId))
      // The group context applies only if the viewer is in it now; otherwise the answer says nothing about it.
      const contextGroup = parsed.groupId !== null && viewerGroups.has(parsed.groupId) ? parsed.groupId : null

      const subjects = facts.subjects.map((subject) => {
        const live = subject.memberships.filter(membership => inEffect(membership, subject.state))
        const inContext = contextGroup ? subject.memberships.find(membership => membership.groupId === contextGroup) ?? null : null
        let relationship: Relationship = 'none'
        if (subject.subjectId === parsed.viewerId) relationship = 'self'
        else if (contextGroup && inContext && live.some(membership => membership.groupId === contextGroup)) relationship = 'same-group'
        else if (contextGroup && inContext && !live.some(membership => membership.groupId === contextGroup)) relationship = 'former-member'
        else if (!contextGroup && live.some(membership => viewerGroups.has(membership.groupId))) relationship = 'same-group'
        else if (live.some(membership => viewerTenants.has(membership.tenantId))) relationship = 'same-tenant'
        return {
          subjectId: subject.subjectId,
          relationship,
          standing: standingOf(subject.state),
          membershipInGroup: inContext ? { kind: inContext.kind, state: inContext.state, endedAt: inContext.endedAt } : null,
        }
      })

      return disclosureContextSchema.parse({
        viewerId: parsed.viewerId,
        groupId: contextGroup,
        departurePolicy: contextGroup ? facts.departurePolicy : null,
        subjects,
        readAt: now.toISOString(),
      })
    },
  }
}
