/**
 * Public presentation surface of `@nuxt4-layers/identity`
 * (`@nuxt4-layers/identity/presentation`).
 *
 * The default pages and components depend on the contract and the client
 * API (`useIdentity()`) only, and decide nothing: every action is decided
 * again on the server.
 */

export type { IdentityMessageKey, IdentityMessages } from './messages'
export { formatMessage, IDENTITY_MESSAGES_EN_GB, resolveMessage } from './messages'
export { DELIBERATE_PAIRINGS } from './pairings'
export { identityClasses } from './utils/identity-classes'
