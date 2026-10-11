import { z } from 'zod'
import { identifierSchema, instantSchema } from './identifiers'
import { IDENTITY_STATES } from './identity'
import { storedSafeNameSchema } from './safe-names'

/**
 * Service identities (docs/contracts.md §23; iam-integration's service
 * identities process): software that acts on a group's behalf. Owned by one
 * group, in its tenant, with a safe name, no personal group and no personal
 * data. Its credentials are Authentication's; its access comes only from the
 * memberships it is explicitly given.
 */

/** A service identity as its owning group's administrators see it. */
export const serviceIdentitySchema = z.strictObject({
  identityId: identifierSchema,
  owningGroupId: identifierSchema,
  tenantId: identifierSchema,
  /** Null only for a service identity created before names existed. */
  name: storedSafeNameSchema.nullable(),
  state: z.enum(IDENTITY_STATES).exclude(['pending', 'paused', 'closure-pending']),
  /** The groups it is a member of now (its memberships that have not ended). */
  groupIds: z.array(identifierSchema).max(1000),
  createdAt: instantSchema,
  stateChangedAt: instantSchema,
})

export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>

/** The service identities a group owns, closed ones excepted. */
export const serviceIdentityListSchema = z.strictObject({
  groupId: identifierSchema,
  serviceIdentities: z.array(serviceIdentitySchema).max(1000),
})

/**
 * Who hears of a service identity's credentials: its owning group and that
 * group's active owners (iam-integration's owners' notices). Server-only.
 */
export const serviceIdentityAudienceSchema = z.strictObject({
  identityId: identifierSchema,
  owningGroupId: identifierSchema,
  ownerIds: z.array(identifierSchema).max(1000),
})

export type ServiceIdentityAudience = z.infer<typeof serviceIdentityAudienceSchema>
