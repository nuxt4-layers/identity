import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EventHandler } from 'h3'
import { createApp, createRouter, defineEventHandler, getRequestHeader, toWebHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdentityAccessDecision, IdentityEvent } from '../../contracts'
import { identityPermissionRisk, resolveIdentityPolicy, SCIM_GROUP_SCHEMA } from '../../contracts'
import { bootstrapRootGroup, provisionTenant, relayOutbox } from '../../server/internal/background'
import type { Database } from '../../server/internal/database'
import { database } from '../../server/internal/database'
import { identityHttpError, originRejected } from '../../server/internal/http'
import { createProvisioning } from '../../server/internal/provisioning'
import {
  clearIdentityComposition,
  provideIdentityAccessDecision,
  provideIdentityApprovalPolicy,
  provideIdentityDatabase,
  provideIdentityPolicy,
  provideIdentitySubjectResolver,
} from '../../server/utils/identity-composition'
import { exportIdentityData, getIdentityJoining, getIdentityScimStructure } from '../../server/utils/identity-server'
import type { TestDatabase } from '../support/database'
import { createTestDatabase, hasDatabase, requireDatabaseInCi, seed } from '../support/database'
import { CORRELATION_ID, uuidv7 } from '../support/fixtures'

requireDatabaseInCi()

const API = fileURLToPath(new URL('../../server/api/identity', import.meta.url))

/** Every endpoint file, routed as Nuxt routes it: `[param]` → `:param`, `index` dropped, method from the suffix. */
function endpointFiles(directory: string = API): { file: string, method: string, route: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return endpointFiles(path)
    const match = /^(.*)\.(get|post|patch|delete)\.ts$/.exec(relative(API, path))
    if (!match) throw new Error(`Unexpected file in server/api/identity: ${entry.name}`)
    const route = `/api/identity/${match[1]!}`.replace(/\[(\w+)\]/g, ':$1').replace(/\/index$/, '')
    return [{ file: path, method: match[2]!, route }]
  })
}

describe.skipIf(!hasDatabase)('the /api/identity endpoints', () => {
  let test: TestDatabase
  let db: Database
  let tenant: string
  let root: string
  let rootOwner: string
  let handler: (request: Request) => Promise<Response>
  let resolverFails = false

  const allowed = new Set<string>()
  const access: IdentityAccessDecision = {
    async decide({ subject, permission, groupId }) {
      return allowed.has(`${subject.principalId}|${permission}|${groupId}`) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  }
  const allow = (principalId: string, permission: string, groupId: string) => allowed.add(`${principalId}|${permission}|${groupId}`)

  async function person(): Promise<string> {
    const provisioning = createProvisioning(db, resolveIdentityPolicy({ defaultHomeTenantId: tenant }))
    const { identityId } = await provisioning.reserve({ requestId: uuidv7(), kind: 'person', correlationId: CORRELATION_ID })
    await provisioning.confirm({ identityId, correlationId: CORRELATION_ID })
    return identityId
  }

  async function call(method: string, path: string, options: { as?: string, body?: unknown, ageSeconds?: number, headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
    if (options.as) headers['x-test-principal'] = `${options.as}|${options.ageSeconds ?? 60}`
    const response = await handler(new Request(`http://identity.test${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }))
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    return { status: response.status, data: json?.data ?? json }
  }

  async function events(): Promise<IdentityEvent[]> {
    const published: IdentityEvent[] = []
    await relayOutbox(db, { publish: async (event) => { published.push(event) } }, 1000)
    return published
  }

  beforeAll(async () => {
    test = await createTestDatabase()
    db = database({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    const operator = database({ dialect: 'postgres', pool: test.admin, schema: test.schema })
    tenant = (await provisionTenant(operator, resolveIdentityPolicy(), { jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId: CORRELATION_ID })).tenantId
    rootOwner = await person()
    root = (await bootstrapRootGroup(operator, { tenantId: tenant, name: 'Company', firstOwnerId: rootOwner, correlationId: CORRELATION_ID })).groupId

    const app = createApp()
    const router = createRouter()
    for (const endpoint of endpointFiles()) {
      const module = await import(endpoint.file) as { default: EventHandler }
      router[endpoint.method as 'get' | 'post' | 'patch' | 'delete'](endpoint.route, module.default)
    }
    app.use(router)
    handler = toWebHandler(app)
  })

  beforeEach(async () => {
    clearIdentityComposition()
    allowed.clear()
    resolverFails = false
    provideIdentityDatabase({ dialect: 'postgres', pool: test.runtime, schema: test.schema })
    provideIdentityAccessDecision(access)
    provideIdentityApprovalPolicy({
      riskOf: async permission => identityPermissionRisk(permission),
      qualifies: async () => false,
      countQualifying: async () => 0,
    })
    provideIdentityPolicy({ platformGroupId: root, defaultHomeTenantId: tenant })
    provideIdentitySubjectResolver({
      async resolve(event) {
        if (resolverFails) throw new Error('authentication is down')
        const header = getRequestHeader(event as never, 'x-test-principal')
        if (!header) return null
        const [principalId, age] = header.split('|')
        return { principalId: principalId!, authenticatedAt: new Date(Date.now() - Number(age) * 1000).toISOString(), assurance: { level: 'aal2', phishingResistant: true } }
      },
    })
    await events()
  })

  afterAll(async () => {
    clearIdentityComposition()
    await test?.drop()
  })

  it('mounts every endpoint file under a route Nuxt would give it', () => {
    const routes = endpointFiles().map(endpoint => `${endpoint.method.toUpperCase()} ${endpoint.route}`)
    expect(routes).toContain('GET /api/identity/me')
    expect(routes).toContain('POST /api/identity/groups')
    expect(routes).toContain('GET /api/identity/groups/:groupId')
    expect(routes).toContain('POST /api/identity/changes/:changeId/decision')
    // Creating an invitation stays with the host, which alone sees the address.
    expect(routes.filter(route => /POST .*invitations$/.test(route))).toEqual([])
  })

  it('answers unauthenticated without a subject, and unavailable when the resolver or a port fails', async () => {
    expect(await call('GET', '/api/identity/me')).toEqual({ status: 401, data: { code: 'unauthenticated', messageKey: 'identity.error.unauthenticated' } })
    resolverFails = true
    expect((await call('GET', '/api/identity/me', { as: rootOwner })).data).toMatchObject({ code: 'unavailable' })
    resolverFails = false
    clearIdentityComposition()
    expect(await call('GET', '/api/identity/me', { as: rootOwner })).toMatchObject({ status: 503, data: { code: 'unavailable' } })
  })

  it('shows the signed-in identity its own view', async () => {
    const { status, data } = await call('GET', '/api/identity/me', { as: rootOwner })
    expect(status).toBe(200)
    expect(data.actor).toMatchObject({ identityId: rootOwner, identityState: 'active' })
    expect(data.lastOwnerOf).toEqual([root])
    expect(data.groupNames).toEqual([{ groupId: root, name: 'Company' }])
  })

  it('creates, shows and renames a group, refusing an unknown group and a refused caller alike', async () => {
    const creator = await person()
    allow(creator, 'identity.groups:create', root)
    const createdGroup = await call('POST', '/api/identity/groups', { as: creator, body: { parentGroupId: root, name: 'Sales' } })
    expect(createdGroup.status).toBe(201)
    const groupId = createdGroup.data.groupId as string

    const unknown = await call('GET', `/api/identity/groups/${uuidv7()}`, { as: creator })
    const refused = await call('GET', `/api/identity/groups/${groupId}`, { as: creator })
    expect(unknown).toEqual(refused)
    expect(refused).toEqual({ status: 403, data: { code: 'forbidden', messageKey: 'identity.error.forbidden' } })

    allow(creator, 'identity.groups:view', groupId)
    allow(creator, 'identity.groups:rename', groupId)
    const shown = await call('GET', `/api/identity/groups/${groupId}`, { as: creator })
    expect(shown.data).toMatchObject({ group: { groupId, name: 'Sales', kind: 'standard', state: 'active' }, lineage: [root, groupId] })
    expect(await call('PATCH', `/api/identity/groups/${groupId}`, { as: creator, body: { name: 'Sales UK' } })).toEqual({ status: 200, data: { groupId, status: 'renamed' } })
    expect(await call('PATCH', `/api/identity/groups/${groupId}`, { as: creator, body: { name: 'Sales', extra: true } }))
      .toEqual({ status: 400, data: { code: 'validation-failed', messageKey: 'identity.error.validation-failed' } })
    expect((await call('PATCH', `/api/identity/groups/${groupId}`, { as: creator, body: { name: 'Pay​roll' } })).data)
      .toEqual({ code: 'validation-failed', messageKey: 'identity.error.validation-failed', reason: 'forbidden-character' })
    expect((await call('GET', '/api/identity/groups/not-an-id', { as: creator })).status).toBe(400)
  })

  it('lists members with what each membership confers now, and names the rule in a conflict', async () => {
    const creator = await person()
    allow(creator, 'identity.groups:create', root)
    const { data: { groupId } } = await call('POST', '/api/identity/groups', { as: creator, body: { parentGroupId: root, name: `Team ${uuidv7().slice(-6)}` } })
    const member = await person()
    await seed(test.admin, [[`insert into identity.membership values ($1, $2, $3, $4, 'member', 'paused', false, false, now() - interval '1 day', null, null, null, null, now(), 1)`, [uuidv7(), member, groupId, tenant]]])
    expect((await call('GET', `/api/identity/groups/${groupId}/members`, { as: creator })).status).toBe(403)
    allow(creator, 'identity.memberships:view', groupId)
    const page = await call('GET', `/api/identity/groups/${groupId}/members`, { as: creator })
    expect(page.data.members.map((entry: { membership: { identityId: string }, effectiveStatus: string }) => [entry.membership.identityId, entry.effectiveStatus]).sort())
      .toEqual([[creator, 'active'], [member, 'paused']].sort())
    expect(page.data.nextCursor).toBeNull()

    const ownMembership = page.data.members.find((entry: { membership: { identityId: string } }) => entry.membership.identityId === creator).membership.membershipId
    expect(await call('POST', `/api/identity/memberships/${ownMembership}/leave`, { as: creator }))
      .toEqual({ status: 409, data: { code: 'conflict', messageKey: 'identity.error.conflict', reason: 'last-owner' } })
  })

  it('names the groups a person has left on their own view, and only those', async () => {
    const creator = await person()
    allow(creator, 'identity.groups:create', root)
    const name = `Former ${uuidv7().slice(-6)}`
    const { data: { groupId } } = await call('POST', '/api/identity/groups', { as: creator, body: { parentGroupId: root, name } })
    const leaver = await person()
    const membershipId = uuidv7()
    await seed(test.admin, [[`insert into identity.membership values ($1, $2, $3, $4, 'member', 'active', false, false, now() - interval '1 day', null, null, null, null, now(), 1)`, [membershipId, leaver, groupId, tenant]]])
    const before = (await call('GET', '/api/identity/me', { as: leaver })).data
    expect(before.groupNames).toContainEqual({ groupId, name })
    expect(before.formerGroupNames).toEqual([])

    expect((await call('POST', `/api/identity/memberships/${membershipId}/leave`, { as: leaver })).status).toBe(200)
    const after = (await call('GET', '/api/identity/me', { as: leaver })).data
    expect(after.groupNames.map((entry: { groupId: string }) => entry.groupId)).not.toContain(groupId)
    expect(after.formerGroupNames).toEqual([{ groupId, name }])
    // A group the person is still in is never "former", and nobody else's departures are shown.
    expect((await call('GET', '/api/identity/me', { as: creator })).data.formerGroupNames).toEqual([])
  })

  it('accepts an invitation with the token in the body, answering alike whatever happened', async () => {
    const inviter = await person()
    allow(inviter, 'identity.groups:create', root)
    const { data: { groupId } } = await call('POST', '/api/identity/groups', { as: inviter, body: { parentGroupId: root, name: `Team ${uuidv7().slice(-6)}` } })
    allow(inviter, 'identity.invitations:manage', groupId)
    const invitee = await person()
    const { token } = await getIdentityJoining().invite({
      subject: { principalId: inviter, authenticatedAt: new Date().toISOString(), assurance: { level: 'aal2', phishingResistant: true } },
      groupId,
      kind: 'member',
      correlationId: CORRELATION_ID,
    })
    expect(await call('POST', '/api/identity/invitations/accept', { as: invitee, body: { token: 'E'.repeat(43) } })).toEqual({ status: 200, data: { status: 'accepted' } })
    expect(await call('POST', '/api/identity/invitations/accept', { as: invitee, body: { token } })).toEqual({ status: 200, data: { status: 'accepted' } })
    const listed = await call('GET', `/api/identity/groups/${groupId}/invitations`, { as: inviter })
    expect(listed.data.map((invitation: { state: string }) => invitation.state)).toEqual(['accepted'])
  })

  it('requests and shows a governance change, and carries the client\'s correlation identifier into its events', async () => {
    const creator = await person()
    allow(creator, 'identity.groups:create', root)
    const { data: { groupId } } = await call('POST', '/api/identity/groups', { as: creator, body: { parentGroupId: root, name: `Team ${uuidv7().slice(-6)}` } })
    allow(creator, 'identity.groups:archive', groupId)
    allow(creator, 'identity.groups:view', groupId)
    await events()
    const correlationId = '0f2b8f1e-6c1d-4a7e-9b3a-2f4d5e6a7b8c'
    const requested = await call('POST', '/api/identity/changes', {
      as: creator,
      headers: { 'x-correlation-id': correlationId },
      body: { request: { type: 'group.archive', target: { groupId }, justification: { reasonCode: 'restructure', reference: null } } },
    })
    expect(requested.status).toBe(201)
    expect(requested.data).toMatchObject({ type: 'group.archive', route: 'parent-owner', state: 'awaiting-approval', correlationId })
    expect((await events()).map(event => [event.type, event.correlationId])).toEqual([['approval.requested', correlationId]])
    expect((await call('GET', `/api/identity/changes/${requested.data.changeId}`, { as: creator })).data).toEqual(requested.data)
    expect((await call('GET', `/api/identity/groups/${groupId}/changes`, { as: creator })).data).toEqual([requested.data])
    const decided = await call('POST', `/api/identity/changes/${requested.data.changeId}/decision`, { as: rootOwner, body: { decision: 'approve', changeDigest: requested.data.changeDigest } })
    expect(decided.data).toMatchObject({ state: 'applied' })
  })

  it('demands reauthentication before pausing the identity', async () => {
    const someone = await person()
    expect(await call('POST', '/api/identity/me/pause', { as: someone, ageSeconds: 3600 }))
      .toEqual({ status: 403, data: { code: 'insufficient-assurance', messageKey: 'identity.error.insufficient-assurance' } })
    expect(await call('POST', '/api/identity/me/pause', { as: someone })).toEqual({ status: 200, data: { state: 'paused', orphanedGroupIds: [] } })
    expect(await call('POST', '/api/identity/me/resume', { as: someone })).toEqual({ status: 200, data: { state: 'active' } })
  })

  it('exports Identity\'s part of a data-subject request, and the SCIM structure, on the server only', async () => {
    const someone = await person()
    const exported = await exportIdentityData({ identityId: someone, correlationId: CORRELATION_ID })
    expect(exported).toMatchObject({ identity: { identityId: someone, kind: 'person', state: 'active' }, externalIds: [], correlationId: CORRELATION_ID })
    expect(exported!.memberships).toHaveLength(1)
    expect(await exportIdentityData({ identityId: uuidv7(), correlationId: CORRELATION_ID })).toBeNull()
    const scim = getIdentityScimStructure()
    expect(await scim.user({ identityId: someone, tenantId: tenant })).toMatchObject({ id: someone, active: true, meta: { resourceType: 'User', version: 'W/"2"' } })
    expect(await scim.group({ groupId: root })).toMatchObject({ schemas: [SCIM_GROUP_SCHEMA], id: root, displayName: 'Company', members: [{ value: rootOwner, type: 'User' }] })
  })
})

describe('the origin check on state-changing requests', () => {
  function app(baseUrl: string | undefined) {
    const instance = createApp()
    instance.use(defineEventHandler((event) => {
      if (originRejected(event, baseUrl)) throw identityHttpError('forbidden')
      return { ok: true }
    }))
    return toWebHandler(instance)
  }
  const send = (handler: (request: Request) => Promise<Response>, method: string, path: string, headers: Record<string, string> = {}) =>
    handler(new Request(`http://identity.test${path}`, { method, headers })).then(response => response.status)

  it('accepts reads from anywhere and writes only from the configured origin', async () => {
    const handler = app('https://app.example')
    expect(await send(handler, 'GET', '/api/identity/me')).toBe(200)
    expect(await send(handler, 'POST', '/api/identity/me/pause', { origin: 'https://app.example' })).toBe(200)
    expect(await send(handler, 'POST', '/api/identity/me/pause', { referer: 'https://app.example/settings' })).toBe(200)
    expect(await send(handler, 'POST', '/api/identity/me/pause', { origin: 'https://evil.example' })).toBe(403)
    expect(await send(handler, 'POST', '/api/identity/me/pause')).toBe(403)
    expect(await send(handler, 'POST', '/api/other/thing', { origin: 'https://evil.example' })).toBe(200)
  })

  it('refuses every write when no base URL is configured', async () => {
    expect(await send(app(''), 'POST', '/api/identity/me/pause', { origin: 'https://app.example' })).toBe(403)
    expect(await send(app(undefined), 'DELETE', '/api/identity/me/closure', { origin: 'https://app.example' })).toBe(403)
  })
})
