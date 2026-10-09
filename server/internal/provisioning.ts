import { createHash } from 'node:crypto'
import type { IdentityPolicy, IdentityProvisioning } from '../../contracts'
import {
  IdentityError,
  provisionedIdentitySchema,
  provisioningConfirmInputSchema,
  provisioningReservationSchema,
  provisioningReserveInputSchema,
  signInOutcome,
  signInStatusSchema,
  UUID_PATTERN,
} from '../../contracts'
import type { Database } from './database'

/** PRIVATE. The provisioning port (docs/contracts.md §10.1) over Identity's database. */

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

function parseInput<T>(parse: () => T): T {
  try {
    return parse()
  }
  catch {
    throw new IdentityError('validation-failed')
  }
}

/** SHA-256 of an invitation token's bytes, as stored. */
export function invitationTokenDigest(token: string): string {
  return createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex')
}

export function createProvisioning(db: Database, policy: IdentityPolicy, clock: Clock = systemClock): IdentityProvisioning {
  async function invitationTenant(token: string, now: Date): Promise<string | null> {
    const { rows } = await db.transaction(client => client.query<{ tenant: string | null }>(
      `select ${db.schema}.invitation_home_tenant($1, $2) as tenant`,
      [invitationTokenDigest(token), now],
    ))
    return rows[0]?.tenant ?? null
  }

  return {
    async reserve(input) {
      const { requestId, homeTenantId, invitationToken } = parseInput(() => provisioningReserveInputSchema.parse(input))
      const now = clock.now()
      // An invitation's tenant becomes the home tenant. An unusable token falls back to the default, revealing nothing.
      const invited = invitationToken ? await invitationTenant(invitationToken, now) : null
      const home = invited ?? homeTenantId ?? policy.defaultHomeTenantId
      if (!home) throw new IdentityError('validation-failed', 'no home tenant: supply one or set defaultHomeTenantId')
      const deadline = new Date(now.getTime() + policy.pendingConfirmationHours * 3_600_000)
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.reserve_identity($1, $2, $3, $4) as result`,
        [requestId, home, deadline, now],
      ))
      return provisioningReservationSchema.parse(rows[0]!.result)
    },

    async confirm(input) {
      const { identityId, correlationId } = parseInput(() => provisioningConfirmInputSchema.parse(input))
      const { rows } = await db.transaction(client => client.query<{ result: unknown }>(
        `select ${db.schema}.confirm_identity($1, $2, $3) as result`,
        [identityId, correlationId, clock.now()],
      ))
      return provisionedIdentitySchema.parse(rows[0]!.result)
    },

    async signInStatus(identityId) {
      if (typeof identityId !== 'string' || !UUID_PATTERN.test(identityId)) return null
      const { rows } = await db.transaction(client => client.query<{ result: { identityId: string, kind: string, state: string } | null }>(
        `select ${db.schema}.sign_in_status($1) as result`,
        [identityId],
      ))
      const found = rows[0]?.result
      if (!found) return null
      return signInStatusSchema.parse({
        ...found,
        signIn: signInOutcome(found.state as never),
        passkeyOnly: found.kind === 'break-glass',
      })
    },
  }
}
