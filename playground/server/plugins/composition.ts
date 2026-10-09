/**
 * Playground composition root: supplies the identity ports the way a host
 * application would. The access decision and approval policy here are fixed
 * development fixtures standing in for the host's Authorisation adapters;
 * they refuse everything, so the playground can never grant anything. The
 * database port is added in phase 2.
 */
import { IDENTITY_PERMISSIONS } from '../../../contracts'

export default defineNitroPlugin(() => {
  provideIdentityAccessDecision({
    async decide() {
      return { allowed: false, reason: 'not-permitted' }
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

  provideIdentityPolicy({ defaultHomeTenantId: null })
})
