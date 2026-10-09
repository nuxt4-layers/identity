import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEPARTURE_POLICY,
  DISCLOSURE_MAX_SUBJECTS,
  IDENTITY_EVENT_PAYLOADS,
  IDENTITY_EVENT_TYPES,
  departurePolicySchema,
  disclosureContextSchema,
  disclosureRequestSchema,
  identityEventSchema,
  standingOf,
} from '../contracts'
import { CORRELATION_ID, NOW, uuidv7 } from './support/fixtures'

function event(type: string, data: Record<string, unknown>) {
  return {
    eventId: uuidv7(),
    type,
    occurredAt: NOW,
    correlationId: CORRELATION_ID,
    actorId: uuidv7(),
    aggregate: { type: 'membership', id: uuidv7(), version: 3 },
    tenantId: uuidv7(),
    data,
  }
}

describe('events', () => {
  it('has a payload schema for every type', () => {
    expect(Object.keys(IDENTITY_EVENT_PAYLOADS).sort()).toEqual([...IDENTITY_EVENT_TYPES].sort())
  })

  it('requires an event identifier, correlation identifier, aggregate version and time', () => {
    const valid = event('membership.ended', { membershipId: uuidv7(), identityId: uuidv7(), groupId: uuidv7(), endReason: 'removed', reasonCode: 'conduct' })
    expect(identityEventSchema.safeParse(valid).success).toBe(true)
    for (const key of ['eventId', 'correlationId', 'aggregate', 'occurredAt'] as const) {
      const { [key]: _omitted, ...rest } = valid
      expect(identityEventSchema.safeParse(rest).success, key).toBe(false)
    }
    expect(identityEventSchema.safeParse({ ...valid, aggregate: { ...valid.aggregate, version: 0 } }).success).toBe(false)
  })

  it('refuses a payload belonging to another type, and unknown types', () => {
    expect(identityEventSchema.safeParse(event('membership.ended', { identityId: uuidv7() })).success).toBe(false)
    expect(identityEventSchema.safeParse(event('identity.renamed', { identityId: uuidv7() })).success).toBe(false)
  })

  it('carries what Profile needs to apply a departure: the end reason, never a name', () => {
    expect(identityEventSchema.safeParse(event('group.settings-changed', { groupId: uuidv7(), changed: ['departure'] })).success).toBe(true)
    expect(identityEventSchema.safeParse(event('membership.ended', { membershipId: uuidv7(), identityId: uuidv7(), groupId: uuidv7(), endReason: 'left', reasonCode: null, leaverName: 'Alice' })).success).toBe(false)
  })
})

describe('departure data policy (a group setting)', () => {
  it('defaults to keep-name, history visible to administrators, and anonymisation on request', () => {
    expect(DEFAULT_DEPARTURE_POLICY).toEqual({ attribution: 'keep-name', historyVisibility: 'administrators', deletionRequests: 'anonymise', retentionReasons: [] })
  })

  it('accepts each documented value and refuses anything else', () => {
    expect(departurePolicySchema.safeParse({ attribution: 'pseudonymise', historyVisibility: 'nobody', deletionRequests: 'review', retentionReasons: ['employment-records'] }).success).toBe(true)
    expect(departurePolicySchema.safeParse({ ...DEFAULT_DEPARTURE_POLICY, attribution: 'delete' }).success).toBe(false)
    expect(departurePolicySchema.safeParse({ ...DEFAULT_DEPARTURE_POLICY, retentionReasons: ['Kept because of the 2019 case'] }).success).toBe(false)
  })
})

describe('disclosure-context port (for Profile)', () => {
  it('is batched and bounded', () => {
    const viewerId = uuidv7()
    expect(disclosureRequestSchema.safeParse({ viewerId, subjectIds: [uuidv7()], groupId: null }).success).toBe(true)
    expect(disclosureRequestSchema.safeParse({ viewerId, subjectIds: [], groupId: null }).success).toBe(false)
    const tooMany = Array.from({ length: DISCLOSURE_MAX_SUBJECTS + 1 }, () => uuidv7())
    expect(disclosureRequestSchema.safeParse({ viewerId, subjectIds: tooMany, groupId: null }).success).toBe(false)
  })

  it('answers with relationships, standings and the group\'s departure policy only', () => {
    const answer = {
      viewerId: uuidv7(),
      groupId: uuidv7(),
      departurePolicy: DEFAULT_DEPARTURE_POLICY,
      subjects: [
        { subjectId: uuidv7(), relationship: 'former-member', standing: 'visible', membershipInGroup: { kind: 'member', state: 'ended', endedAt: NOW } },
        { subjectId: uuidv7(), relationship: 'same-tenant', standing: 'paused', membershipInGroup: null },
      ],
      readAt: NOW,
    }
    expect(disclosureContextSchema.safeParse(answer).success).toBe(true)
    expect(disclosureContextSchema.safeParse({ ...answer, subjects: [{ ...answer.subjects[0], displayName: 'Alice' }] }).success).toBe(false)
  })

  it('maps identity states to standings, hiding paused and closing people', () => {
    expect(['active', 'paused', 'suspended', 'closure-pending', 'closed', null].map(standingOf)).toEqual(['visible', 'paused', 'suspended', 'closing', 'gone', 'gone'])
  })
})
