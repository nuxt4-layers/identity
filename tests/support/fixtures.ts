import { randomBytes } from 'node:crypto'
import type { GroupRecord, IdentityRecord, MembershipRecord } from '../../contracts'
import { DEFAULT_GROUP_SETTINGS } from '../../contracts'

/** A fresh lower-case UUIDv7. Test support only. */
export function uuidv7(at: number = Date.now()): string {
  const bytes = randomBytes(16)
  let time = BigInt(at)
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const NOW = '2026-10-09T12:00:00.000Z'

export function person(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    identityId: uuidv7(),
    kind: 'person',
    state: 'active',
    previousState: null,
    homeTenantId: uuidv7(),
    personalGroupId: uuidv7(),
    ownerGroupId: null,
    createdAt: NOW,
    stateChangedAt: NOW,
    deadlineAt: null,
    version: 1,
    ...overrides,
  }
}

export function standardGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    groupId: uuidv7(),
    tenantId: uuidv7(),
    kind: 'standard',
    parentGroupId: null,
    name: 'London office',
    externalId: null,
    state: 'active',
    settings: structuredClone(DEFAULT_GROUP_SETTINGS),
    createdAt: NOW,
    version: 1,
    ...overrides,
  }
}

export function membership(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    membershipId: uuidv7(),
    identityId: uuidv7(),
    groupId: uuidv7(),
    tenantId: uuidv7(),
    kind: 'member',
    state: 'active',
    owner: false,
    foundingOwner: false,
    startsAt: NOW,
    endsAt: null,
    endedAt: null,
    endReason: null,
    reasonCode: null,
    createdAt: NOW,
    version: 1,
    ...overrides,
  }
}

export const CORRELATION_ID = uuidv7()
