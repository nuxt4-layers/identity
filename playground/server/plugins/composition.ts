/**
 * Playground composition root: supplies the identity ports the way a host
 * application would. Not published.
 *
 * By default the access decision and approval policy are fixtures that
 * refuse everything, nobody is ever signed in, and there is no database: the
 * playground only proves the layer composes.
 *
 * With IDENTITY_PLAYGROUND_TEST=1 (browser tests only), it migrates and uses
 * a disposable database, allows every permission (except to the seed's
 * outsiders), and takes the signed-in
 * identity from the `identity_playground_principal` cookie, standing in for
 * Authentication:
 * - IDENTITY_MIGRATION_DATABASE_URL  the migration role's connection
 * - IDENTITY_DATABASE_URL            the runtime role's connection
 * - IDENTITY_RUNTIME_ROLE            the runtime role's name
 */
import pg from 'pg'
import { getCookie } from 'h3'
import type { H3Event } from 'h3'
import { IDENTITY_PERMISSIONS, UUID_V7_PATTERN } from '../../../contracts'

const testMode = process.env.IDENTITY_PLAYGROUND_TEST === '1'

export interface PlaygroundState {
  ready: Promise<void>
  operator: pg.Pool | null
  /** Identities refused every permission, standing in for people Authorisation grants nothing. */
  outsiders: Set<string>
}

export const playground: PlaygroundState = { ready: Promise.resolve(), operator: null, outsiders: new Set() }

export default defineNitroPlugin(() => {
  provideIdentityAccessDecision({
    async decide({ subject }) {
      return testMode && !playground.outsiders.has(subject.principalId) ? { allowed: true } : { allowed: false, reason: 'not-permitted' }
    },
  })

  provideIdentityApprovalPolicy({
    async riskOf(permission) {
      return IDENTITY_PERMISSIONS.find(definition => definition.name === permission)?.risk ?? null
    },
    async qualifies() {
      return false
    },
    async countQualifying() {
      return 0
    },
  })

  provideIdentityEventPublisher({
    async publish(event) {
      console.info(`[playground events] ${event.type}`, { eventId: event.eventId, correlationId: event.correlationId })
    },
  })

  // A host adapts Authentication's getAuthenticatedPrincipal(event) here.
  provideIdentitySubjectResolver({
    async resolve(event) {
      if (!testMode) return null
      const principalId = getCookie(event as H3Event, 'identity_playground_principal')
      if (!principalId || !UUID_V7_PATTERN.test(principalId)) return null
      return { principalId, authenticatedAt: new Date().toISOString(), assurance: { level: 'aal2', phishingResistant: true } }
    },
  })

  provideIdentityPolicy({ defaultHomeTenantId: null })

  if (testMode) {
    const migration = new pg.Pool({ connectionString: process.env.IDENTITY_MIGRATION_DATABASE_URL })
    playground.operator = migration
    playground.ready = migrateIdentityDatabase({ pool: migration, runtimeRole: process.env.IDENTITY_RUNTIME_ROLE ?? 'identity_runtime' }).then(() => {
      provideIdentityDatabase({ dialect: 'postgres', pool: new pg.Pool({ connectionString: process.env.IDENTITY_DATABASE_URL }) })
    })
  }
})
