import { z } from 'zod'
import { externalIdSchema, identifierSchema, instantSchema } from './identifiers'
import type { IdentityState } from './identity'
import { storedSafeNameSchema } from './safe-names'

/**
 * SCIM 2.0 compatibility (improvement register item 5; RFC 7643).
 *
 * Identity supplies the structural part of SCIM resources: `id`,
 * `externalId`, `active`, group `displayName`, `members` and `meta`. The
 * attributes that describe a person (`userName`, `name`, `emails`) are not
 * Identity's: `userName` comes from Authentication and the rest from Profile,
 * and a SCIM endpoint composed by the host (iam-integration) merges them.
 */

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'

const metaSchema = (resourceType: 'User' | 'Group') => z.strictObject({
  resourceType: z.literal(resourceType),
  created: instantSchema,
  lastModified: instantSchema,
  /** Weak ETag from the aggregate version, e.g. `W/"7"`. */
  version: z.string().regex(/^W\/"[0-9]+"$/),
})

export const scimUserStructureSchema = z.strictObject({
  schemas: z.tuple([z.literal(SCIM_USER_SCHEMA)]),
  id: identifierSchema,
  externalId: externalIdSchema.optional(),
  active: z.boolean(),
  meta: metaSchema('User'),
})

export const scimGroupStructureSchema = z.strictObject({
  schemas: z.tuple([z.literal(SCIM_GROUP_SCHEMA)]),
  id: identifierSchema,
  externalId: externalIdSchema.optional(),
  displayName: storedSafeNameSchema,
  members: z.array(z.strictObject({ value: identifierSchema, type: z.literal('User') })),
  meta: metaSchema('Group'),
})

/**
 * SCIM `active`: whether the identity may sign in and act. A paused person
 * can sign in to view and resume, so is `active`; `pending`, `suspended`,
 * `closure-pending` and `closed` are not.
 */
export function scimActive(state: IdentityState): boolean {
  return state === 'active' || state === 'paused'
}

/** A SCIM weak ETag from an aggregate version. */
export function scimVersion(version: number): string {
  return `W/"${version}"`
}
