import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as contracts from '../contracts'

const root = normalize(join(import.meta.dirname, '..'))

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts'))
    .map(file => join(dir, file))
}

/** Import specifiers, with relative ones resolved to repository paths. */
function imports(file: string): string[] {
  const source = readFileSync(join(root, file), 'utf8')
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(([, specifier]) =>
    specifier!.startsWith('.') ? relative(root, join(root, dirname(file), specifier!)) : specifier!)
}

const contractFiles = [...files('contracts'), ...files('shared'), ...files('conformance')]

describe('Identity public contract', () => {
  it('imports nothing but zod and its own modules', () => {
    for (const file of contractFiles) {
      for (const target of imports(file)) {
        expect(target === 'zod' || /^(contracts|shared|conformance)(\/|$)/.test(target), `${file} imports ${target}`).toBe(true)
      }
    }
  })

  it('does not leak driver, vendor or other capabilities\' package names', () => {
    const forbidden = /kysely|drizzle|supabase|better-auth|^pg$|^@nuxt4-layers\//i
    for (const file of contractFiles) {
      for (const target of imports(file)) expect(target, file).not.toMatch(forbidden)
    }
  })

  it('keeps tenancy a separate module that imports nothing else of Identity\'s', () => {
    expect(imports('shared/tenant.ts').filter(target => target !== 'zod')).toEqual(['shared/identifiers'])
  })

  it('maps every error code to an HTTP status', () => {
    for (const code of contracts.IDENTITY_ERROR_CODES) {
      expect(contracts.IDENTITY_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400)
    }
    expect(Object.keys(contracts.IDENTITY_ERROR_STATUS).sort()).toEqual([...contracts.IDENTITY_ERROR_CODES].sort())
  })

  it('has no error code that would reveal whether an identity, group, membership or invitation exists', () => {
    for (const code of contracts.IDENTITY_ERROR_CODES) {
      expect(code).not.toMatch(/not-found|unknown|exists|missing|group|member|identity|invitation|account/)
    }
    expect(contracts.isIdentityErrorCode('forbidden')).toBe(true)
    expect(contracts.isIdentityErrorCode('not-found')).toBe(false)
  })

  it('answers invitation requests with one acknowledgement, whatever happened', () => {
    expect(contracts.INVITATION_ACKNOWLEDGEMENT).toEqual({ status: 'accepted' })
    expect(Object.isFrozen(contracts.INVITATION_ACKNOWLEDGEMENT)).toBe(true)
  })

  it('namespaces every event type by aggregate', () => {
    for (const type of contracts.IDENTITY_EVENT_TYPES) {
      expect(type).toMatch(/^(identity|membership|group|invitation|join-request|tenant|approval|break-glass)\.[a-z-]+$/)
    }
  })

  it('names every permission in Authorisation\'s grammar, unique, with a risk level', () => {
    const grammar = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*:[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
    const names = contracts.IDENTITY_PERMISSIONS.map(permission => permission.name)
    expect(new Set(names).size).toBe(names.length)
    for (const permission of contracts.IDENTITY_PERMISSIONS) {
      expect(permission.name).toMatch(grammar)
      expect(permission.name.startsWith('identity.')).toBe(true)
      expect(contracts.IDENTITY_RISK_LEVELS).toContain(permission.risk)
    }
  })

  it('uses the risk levels the iam-integration processes set', () => {
    const risk = (name: contracts.IdentityPermissionName) => contracts.identityPermissionRisk(name)
    expect(risk('identity.root-groups:create')).toBe('high')
    expect(risk('identity.groups:reparent')).toBe('critical')
    expect(risk('identity.groups:archive')).toBe('high')
    expect(risk('identity.group-owners:manage')).toBe('critical')
    expect(risk('identity.group-approvals:manage')).toBe('critical')
    expect(risk('identity.identities:suspend')).toBe('high')
    expect(risk('identity.service-identities:create')).toBe('high')
    expect(risk('identity.orphaned-groups:recover')).toBe('critical')
  })

  it('maps every governance change to an Identity permission', () => {
    const names = new Set<string>(contracts.IDENTITY_PERMISSIONS.map(permission => permission.name))
    for (const type of contracts.GOVERNANCE_CHANGE_TYPES) expect(names.has(contracts.GOVERNANCE_CHANGES[type].permission)).toBe(true)
  })

  it('reserves the group pause setting with the single value `allowed`', () => {
    expect(contracts.PAUSE_SETTINGS).toEqual(['allowed'])
    expect(contracts.DEFAULT_GROUP_SETTINGS.pausing).toBe('allowed')
  })

  it('bounds directory staleness for revocation at Authorisation\'s bound', () => {
    expect(contracts.IDENTITY_MAX_STALENESS_SECONDS).toBeLessThanOrEqual(30)
    expect(contracts.DIRECTORY_CONSISTENCIES).toEqual(['strong', 'bounded'])
  })

  it('lists the lifecycle events Profile consumes, all of them published by Identity', () => {
    for (const type of contracts.PROFILE_CONSUMED_EVENT_TYPES) expect(contracts.IDENTITY_EVENT_TYPES).toContain(type)
    expect(contracts.PROFILE_CONSUMED_EVENT_TYPES).toEqual(expect.arrayContaining([
      'identity.provisioned', 'identity.paused', 'identity.resumed', 'identity.suspended', 'identity.closed',
      'membership.added', 'membership.ended', 'group.settings-changed',
    ]))
  })
})
