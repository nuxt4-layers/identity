import { GOVERNANCE_CHANGE_TYPES, IDENTITY_ERROR_CODES, IDENTITY_STATES, INVITATION_STATES, PENDING_CHANGE_STATES } from '../../contracts'

/** The contract's vocabularies the default pages put into words. */
export const ERROR_CODES_FOR_TEST = IDENTITY_ERROR_CODES
export const CHANGE_TYPES_FOR_TEST = GOVERNANCE_CHANGE_TYPES
export const STATES_FOR_TEST = [
  ...IDENTITY_STATES.filter(state => state !== 'pending').map(state => `identity.state.${state}`),
  ...INVITATION_STATES.map(state => `identity.invitationState.${state}`),
  ...PENDING_CHANGE_STATES.map(state => `identity.changeState.${state}`),
  ...['active', 'paused', 'suspended', 'ended', 'not-started'].map(status => `identity.status.${status}`),
  ...['active', 'orphaned', 'archived'].map(state => `identity.groupState.${state}`),
  ...['approvers', 'parent-owner', 'tenant-owner', 'published-delay', 'platform-operator', 'none'].map(route => `identity.route.${route}`),
]
