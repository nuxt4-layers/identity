import { z } from 'zod'

/**
 * Identifiers, codes and timestamps: the only kinds of value Identity stores
 * besides group names. Every one is constrained by a pattern, so none can
 * carry a name, an email address or other free text (docs/contracts.md §2).
 */

/** A lower-case UUIDv7. Every identifier Identity issues has this form. */
export const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Any RFC 9562 UUID, lower case. Correlation identifiers are issued by the host. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Opaque identifier of an identity, group, tenant, membership, invitation, change or event. */
export const identifierSchema = z.string().regex(UUID_V7_PATTERN, 'Expected a lower-case UUIDv7')

/** The correlation identifier of the request that started a process (iam-integration architecture §5). */
export const correlationIdSchema = z.string().regex(UUID_PATTERN, 'Expected a lower-case UUID')

/** ISO 8601 instant in UTC, e.g. `2026-10-09T12:00:00.000Z`. */
export const instantSchema = z.iso.datetime()

/**
 * A reason code, never free text: `abuse`, `legal-order`, `left-organisation`.
 * Actions taken against a person record a code (iam-integration processes).
 */
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const reasonCodeSchema = z.string().max(64).regex(REASON_CODE_PATTERN, 'Expected a reason code such as legal-order')

/** A host-registered code for a jurisdiction (`uk-gdpr`) or a data region (`uk-south`). */
export const registryCodeSchema = z.string().max(32).regex(REASON_CODE_PATTERN, 'Expected a code such as uk-gdpr')

/**
 * SCIM `externalId`: the identifier a provisioning client (an enterprise
 * directory) uses for the resource. Opaque; unique per tenant. Values with
 * `@` or whitespace are refused so that an email address cannot be used as
 * one.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,254}$/
export const externalIdSchema = z.string().regex(EXTERNAL_ID_PATTERN, 'Expected an opaque identifier without @ or spaces')

/**
 * A reference that justifies a governance change where the group requires
 * one, such as a ticket number (`CHG-1042`). Never a sentence.
 */
export const justificationReferenceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/, 'Expected a reference such as CHG-1042')

/** Lower-case hexadecimal SHA-256 digest. */
export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 digest')

/** Aggregate version: starts at 1 and increases by one with every change. */
export const versionSchema = z.number().int().min(1)

export type Identifier = z.infer<typeof identifierSchema>
export type CorrelationId = z.infer<typeof correlationIdSchema>
export type Instant = z.infer<typeof instantSchema>
export type ReasonCode = z.infer<typeof reasonCodeSchema>
