import { z } from 'zod'

/**
 * Safe names (improvement register item 6). Identity holds one kind of
 * human-readable text: a group's name. Profile applies the same rules to
 * person names in its own contract.
 *
 * A safe name is:
 *
 * 1. Unicode NFC, with surrounding space trimmed and internal runs of
 *    space separators collapsed to one U+0020;
 * 2. free of control, format (zero-width, bidirectional overrides),
 *    private-use, unassigned and surrogate code points, and of line or
 *    paragraph separators;
 * 3. written in one script, or one of the combinations UTS #39 calls
 *    "highly restrictive" (Latin with Han and Japanese kana, with Han and
 *    Bopomofo, or with Han and Hangul), so `Аcme` with a Cyrillic `А` is
 *    refused;
 * 4. between 1 and `SAFE_NAME_MAX_LENGTH` code points.
 *
 * Whole-script look-alikes (`Асме` written entirely in Cyrillic) pass these
 * checks. `confusableSkeleton` maps a name to a skeleton so the server can
 * refuse a name whose skeleton equals a sibling group's (phase 2).
 */

export const SAFE_NAME_MAX_LENGTH = 100

export const SAFE_NAME_PROBLEMS = [
  'empty',
  'too-long',
  'forbidden-character',
  'mixed-script',
] as const

export type SafeNameProblem = typeof SAFE_NAME_PROBLEMS[number]

export type SafeNameResult =
  | { ok: true, value: string }
  | { ok: false, problem: SafeNameProblem }

const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u
const SPACES = /\p{Zs}+/gu
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u

const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Bengali', /\p{Script=Bengali}/u],
  ['Gurmukhi', /\p{Script=Gurmukhi}/u],
  ['Gujarati', /\p{Script=Gujarati}/u],
  ['Tamil', /\p{Script=Tamil}/u],
  ['Telugu', /\p{Script=Telugu}/u],
  ['Kannada', /\p{Script=Kannada}/u],
  ['Malayalam', /\p{Script=Malayalam}/u],
  ['Sinhala', /\p{Script=Sinhala}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Lao', /\p{Script=Lao}/u],
  ['Khmer', /\p{Script=Khmer}/u],
  ['Myanmar', /\p{Script=Myanmar}/u],
  ['Georgian', /\p{Script=Georgian}/u],
  ['Ethiopic', /\p{Script=Ethiopic}/u],
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Bopomofo', /\p{Script=Bopomofo}/u],
  ['Hangul', /\p{Script=Hangul}/u],
]

/** Script combinations allowed together (UTS #39 §5.2, highly restrictive). */
const ALLOWED_COMBINATIONS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['Latin', 'Han', 'Hiragana', 'Katakana']),
  new Set(['Latin', 'Han', 'Bopomofo']),
  new Set(['Latin', 'Han', 'Hangul']),
]

function scriptOf(character: string): string | null {
  if (NEUTRAL.test(character)) return null
  for (const [name, pattern] of SCRIPTS) if (pattern.test(character)) return name
  return 'Other'
}

/** The scripts a name uses, ignoring Common and Inherited characters (digits, punctuation, marks). */
export function scriptsOf(value: string): ReadonlySet<string> {
  const scripts = new Set<string>()
  for (const character of value) {
    const script = scriptOf(character)
    if (script) scripts.add(script)
  }
  return scripts
}

function isRestrictive(scripts: ReadonlySet<string>): boolean {
  if (scripts.size <= 1) return true
  return ALLOWED_COMBINATIONS.some(allowed => [...scripts].every(script => allowed.has(script)))
}

/** Normalises and checks a name. Never throws. */
export function checkSafeName(input: string, maxLength: number = SAFE_NAME_MAX_LENGTH): SafeNameResult {
  if (typeof input !== 'string') return { ok: false, problem: 'empty' }
  const normalised = input.normalize('NFC')
  // Before trimming: JavaScript's trim() would silently remove a byte-order mark.
  if (FORBIDDEN.test(normalised)) return { ok: false, problem: 'forbidden-character' }
  const value = normalised.replace(SPACES, ' ').trim()
  if (value.length === 0) return { ok: false, problem: 'empty' }
  if ([...value].length > maxLength) return { ok: false, problem: 'too-long' }
  if (!isRestrictive(scriptsOf(value))) return { ok: false, problem: 'mixed-script' }
  return { ok: true, value }
}

/**
 * A schema that accepts a safe name and outputs its normalised form. The
 * error message is the problem code, so clients can localise it.
 */
export const safeGroupNameSchema = z.string().transform((input, context) => {
  const result = checkSafeName(input)
  if (!result.ok) {
    context.addIssue({ code: 'custom', message: result.problem })
    return z.NEVER
  }
  return result.value
})

/**
 * The stored form of a safe name: already normalised, so it passes the
 * checks unchanged. Used in records, events and port answers.
 */
export const storedSafeNameSchema = z.string().max(SAFE_NAME_MAX_LENGTH * 2).refine(
  value => { const result = checkSafeName(value); return result.ok && result.value === value },
  'Expected a normalised safe name',
)

/**
 * Common cross-script look-alikes, mapped to the Latin letter they imitate.
 * A deliberate subset of the UTS #39 confusables data, sufficient for the
 * contract's tests; the server may use the full table (docs/threat-model.md).
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c',
  т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ь: 'b', һ: 'h', ӏ: 'l',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // Latin and digits that look alike within one script
  ı: 'i', ℓ: 'l', '0': 'o', '1': 'l', '|': 'l',
}

/**
 * A comparison key: compatibility-normalised, case-folded, with marks
 * removed, look-alikes mapped and spaces removed. Two group names with the
 * same skeleton are confusable.
 */
export function confusableSkeleton(value: string): string {
  const folded = value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  let skeleton = ''
  for (const character of folded) {
    if (/\s/u.test(character)) continue
    skeleton += CONFUSABLES[character] ?? character
  }
  return skeleton.replace(/rn/g, 'm').replace(/vv/g, 'w')
}
