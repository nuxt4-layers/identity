import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_IDENTITY_POLICY, IdentityCompositionError } from '../contracts'
import {
  clearIdentityComposition,
  provideIdentityAccessDecision,
  provideIdentityApprovalPolicy,
  provideIdentityDatabase,
  provideIdentityEventPublisher,
  provideIdentityPolicy,
  useIdentityAccessDecision,
  useIdentityApprovalPolicy,
  useIdentityDatabase,
  useIdentityEventPublisher,
  useIdentityPolicy,
} from '../server/utils/identity-composition'
import {
  getIdentityDirectory,
  getIdentityDisclosureContext,
  getIdentityGovernance,
  getIdentityProvisioning,
  provisionIdentityTenant,
  relayIdentityOutbox,
  runIdentityMaintenance,
} from '../server/utils/identity-server'

const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() }

afterEach(() => {
  clearIdentityComposition()
})

describe('Identity composition ports', () => {
  it.each([
    ['IdentityDatabase', useIdentityDatabase],
    ['IdentityAccessDecision', useIdentityAccessDecision],
    ['IdentityApprovalPolicy', useIdentityApprovalPolicy],
    ['IdentityEventPublisher', useIdentityEventPublisher],
  ] as const)('fails closed when %s is absent', (port, use) => {
    expect(() => use()).toThrow(IdentityCompositionError)
    expect(() => use()).toThrow(new RegExp(port))
  })

  it('supplies the database with the default capability-owned schema', () => {
    provideIdentityDatabase({ dialect: 'postgres', pool })
    expect(useIdentityDatabase()).toEqual({ dialect: 'postgres', pool, schema: 'identity' })
  })

  it.each([
    ['a non-postgres dialect', { dialect: 'mysql', pool }],
    ['a pool without query()', { dialect: 'postgres', pool: {} }],
    ['an unsafe schema name', { dialect: 'postgres', pool, schema: 'identity; drop schema public' }],
    ['an upper-case schema name', { dialect: 'postgres', pool, schema: 'Identity' }],
  ])('rejects %s', (_label, input) => {
    expect(() => provideIdentityDatabase(input as never)).toThrow(TypeError)
    expect(() => useIdentityDatabase()).toThrow(IdentityCompositionError)
  })

  it('rejects ports without their functions', () => {
    expect(() => provideIdentityAccessDecision({} as never)).toThrow(TypeError)
    expect(() => provideIdentityApprovalPolicy({ riskOf: vi.fn(), qualifies: vi.fn() } as never)).toThrow(TypeError)
    expect(() => provideIdentityEventPublisher({} as never)).toThrow(TypeError)
  })

  it('supplies each port once valid', () => {
    const decide = { decide: vi.fn() }
    const approvals = { riskOf: vi.fn(), qualifies: vi.fn(), countQualifying: vi.fn() }
    const publisher = { publish: vi.fn() }
    provideIdentityAccessDecision(decide)
    provideIdentityApprovalPolicy(approvals)
    provideIdentityEventPublisher(publisher)
    expect(useIdentityAccessDecision()).toBe(decide)
    expect(useIdentityApprovalPolicy()).toBe(approvals)
    expect(useIdentityEventPublisher()).toBe(publisher)
  })

  it('uses the secure default policy when the host supplies none', () => {
    expect(useIdentityPolicy()).toEqual(DEFAULT_IDENTITY_POLICY)
  })

  it('validates host policy when it is supplied, not when it is first used', () => {
    expect(() => provideIdentityPolicy({ closureGraceDays: 7 })).toThrow(/riskTreatment/)
    provideIdentityPolicy({ closureGraceDays: 60 })
    expect(useIdentityPolicy().closureGraceDays).toBe(60)
  })

  it('fails closed in every server function when the database is absent', async () => {
    expect(() => getIdentityProvisioning()).toThrow(IdentityCompositionError)
    expect(() => getIdentityDirectory()).toThrow(IdentityCompositionError)
    expect(() => getIdentityDisclosureContext()).toThrow(IdentityCompositionError)
    expect(() => getIdentityGovernance()).toThrow(IdentityCompositionError)
    expect(() => runIdentityMaintenance()).toThrow(IdentityCompositionError)
    expect(() => provisionIdentityTenant({ jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: '01a120c9-2cd1-784a-a3d6-f725b2cb2eab' })).toThrow(IdentityCompositionError)
  })

  it('refuses governance without the access-decision port, even with a database', () => {
    provideIdentityDatabase({ dialect: 'postgres', pool })
    expect(() => getIdentityGovernance()).toThrow(/IdentityAccessDecision/)
  })

  it('refuses to relay the outbox without a publisher, even with a database', () => {
    provideIdentityDatabase({ dialect: 'postgres', pool })
    expect(() => relayIdentityOutbox()).toThrow(/IdentityEventPublisher/)
  })
})

