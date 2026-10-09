import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { IDENTITY_DATA_SCHEMAS, identityEventSchema, identitySchema, membershipSchema, storedSafeNameSchema } from '../contracts'
import { CORRELATION_ID, NOW, membership, person, uuidv7 } from './support/fixtures'

/**
 * The contract test that Identity holds no personal data (ADR-0005 §1, §2.8).
 *
 * It walks every schema in `IDENTITY_DATA_SCHEMAS` (every stored record,
 * published event and port answer) and proves three things:
 *
 * 1. every object is strict, so no undeclared field can be smuggled in;
 * 2. no field is named for personal data (name, email, phone, address,
 *    birth date and so on), except a group's own name;
 * 3. every string is constrained to a pattern (an identifier, a code, an
 *    instant, a digest) or a fixed set of values, except a group's name,
 *    which must be a safe name. So no field can carry free text, and so no
 *    field can carry a name, an address or a sentence about a person.
 */

interface Leaf { path: string, kind: 'constrained-string' | 'free-string' | 'safe-name' | 'other' }

const def = (schema: z.ZodType): any => (schema as any)._zod.def

function walk(schema: z.ZodType, path: string, leaves: Leaf[], objects: { path: string, strict: boolean, keys: string[] }[]): void {
  if (schema === storedSafeNameSchema) {
    leaves.push({ path, kind: 'safe-name' })
    return
  }
  const d = def(schema)
  switch (d.type) {
    case 'object':
      objects.push({ path, strict: def(d.catchall ?? ({ _zod: { def: { type: 'unknown' } } } as never))?.type === 'never', keys: Object.keys(d.shape) })
      for (const [key, child] of Object.entries<z.ZodType>(d.shape)) walk(child, `${path}.${key}`, leaves, objects)
      return
    case 'nullable':
    case 'optional':
    case 'default':
    case 'readonly':
      walk(d.innerType, path, leaves, objects)
      return
    case 'array':
      walk(d.element, `${path}[]`, leaves, objects)
      return
    case 'tuple':
      d.items.forEach((item: z.ZodType, index: number) => walk(item, `${path}[${index}]`, leaves, objects))
      return
    case 'union':
      d.options.forEach((option: z.ZodType, index: number) => walk(option, `${path}|${index}`, leaves, objects))
      return
    case 'pipe':
      walk(d.in, path, leaves, objects)
      return
    case 'string': {
      // A format schema (`z.iso.datetime()`) or a pattern check (`.regex()`).
      const constrained = typeof d.format === 'string' || (d.checks ?? []).some((check: any) => check._zod.def.check === 'string_format')
      leaves.push({ path, kind: constrained ? 'constrained-string' : 'free-string' })
      return
    }
    case 'literal':
    case 'enum':
    case 'boolean':
    case 'number':
    case 'never':
      leaves.push({ path, kind: 'other' })
      return
    default:
      throw new Error(`Unhandled schema type '${d.type}' at ${path}: extend the walker before adding it to the contract`)
  }
}

const leaves: Leaf[] = []
const objects: { path: string, strict: boolean, keys: string[] }[] = []
for (const [name, schema] of Object.entries(IDENTITY_DATA_SCHEMAS)) walk(schema, name, leaves, objects)

const PERSONAL_DATA_KEY = /e-?mail|phone|mobile|address|postcode|post-?code|zip|birth|dob|^age$|gender|sex$|nationality|ethnic|religion|avatar|photo|image|picture|given|family|surname|first-?name|last-?name|nickname|user-?name|display|^name$|locale|zoneinfo|^ip$|ip-?address|bio$|note|comment|message|text|description|title|salutation|signature|label/i

/** The only places a name may appear: a group's own safe name. */
const SAFE_NAME_PATHS = ['group.name', 'groupView.group.name', 'pendingChange.target|0.name', 'scimGroupStructure.displayName']

describe('Identity holds no personal data', () => {
  it('covers every record, event and port answer', () => {
    expect(Object.keys(IDENTITY_DATA_SCHEMAS).sort()).toEqual([
      'actorContext', 'breakGlassReview', 'disclosureContext', 'event', 'group', 'groupDescription', 'groupMembersPage', 'groupView', 'identity',
      'identityExport', 'identityExternalId', 'invitation', 'joinRequest', 'membership', 'pendingChange', 'provisionedIdentity', 'provisioningReservation',
      'scimGroupStructure', 'scimUserStructure', 'selfView', 'signInStatus', 'tenant',
    ])
    expect(leaves.length).toBeGreaterThan(200)
  })

  it('makes every object strict, so no undeclared field is accepted', () => {
    expect(objects.filter(object => !object.strict).map(object => object.path)).toEqual([])
  })

  it('names no field for personal data, except a group\'s own name', () => {
    const offending = objects.flatMap(object => object.keys
      .filter(key => PERSONAL_DATA_KEY.test(key))
      .map(key => `${object.path}.${key}`))
      .filter(path => !SAFE_NAME_PATHS.includes(path))
    expect(offending).toEqual([])
  })

  it('has no unconstrained string anywhere: every string is an identifier, code, instant, digest or safe group name', () => {
    expect(leaves.filter(leaf => leaf.kind === 'free-string').map(leaf => leaf.path)).toEqual([])
  })

  it('allows a safe name only as a group\'s name', () => {
    expect(leaves.filter(leaf => leaf.kind === 'safe-name').map(leaf => leaf.path).sort()).toEqual([...SAFE_NAME_PATHS].sort())
  })

  it('refuses a record or event carrying an extra personal field', () => {
    expect(identitySchema.safeParse(person()).success).toBe(true)
    expect(identitySchema.safeParse({ ...person(), email: 'alice@example.test' }).success).toBe(false)
    expect(membershipSchema.safeParse({ ...membership(), displayName: 'Alice' }).success).toBe(false)
    const event = {
      eventId: uuidv7(),
      type: 'identity.paused',
      occurredAt: NOW,
      correlationId: CORRELATION_ID,
      actorId: null,
      aggregate: { type: 'identity', id: uuidv7(), version: 2 },
      tenantId: null,
      data: { identityId: uuidv7() },
    }
    expect(identityEventSchema.safeParse(event).success).toBe(true)
    expect(identityEventSchema.safeParse({ ...event, data: { ...event.data, name: 'Alice' } }).success).toBe(false)
  })

  it('refuses an email address, a sentence or a name where an identifier or code is expected', () => {
    expect(membershipSchema.safeParse(membership({ reasonCode: 'Alice Smith was rude' })).success).toBe(false)
    expect(membershipSchema.safeParse(membership({ identityId: 'alice@example.test' })).success).toBe(false)
    expect(identitySchema.safeParse(person({ identityId: 'alice' })).success).toBe(false)
  })

  it('would catch a loose object, a free-text field or a personal field name (the walker itself is tested)', () => {
    const probeLeaves: Leaf[] = []
    const probeObjects: { path: string, strict: boolean, keys: string[] }[] = []
    walk(z.object({ email: z.string().max(200) }), 'probe', probeLeaves, probeObjects)
    expect(probeObjects[0]!.strict).toBe(false)
    expect(probeLeaves).toEqual([{ path: 'probe.email', kind: 'free-string' }])
    expect(PERSONAL_DATA_KEY.test('email')).toBe(true)
    expect(PERSONAL_DATA_KEY.test('givenName')).toBe(true)
    expect(PERSONAL_DATA_KEY.test('lineage')).toBe(false)
  })
})
