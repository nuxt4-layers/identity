import { globSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IDENTITY_MESSAGES_EN_GB } from '../presentation/messages'
import { DELIBERATE_PAIRINGS } from '../presentation/pairings'
import { identityClasses } from '../presentation/utils/identity-classes'
import { CHANGE_TYPES_FOR_TEST, ERROR_CODES_FOR_TEST, STATES_FOR_TEST } from './support/presentation-vocabulary'

/**
 * Theme Manager's Semantic Presentation Guide: Fill, Pen and Edge of one
 * surface share a role and state, and cross-role pairings are deliberate.
 * Every utility, sizes included, resolves to a Theme Manager token. The same
 * rules as Authentication's pages, so the suite's pages look and behave alike.
 */

const CARD = 'fill-base-default'
const deliberate = new Set(DELIBERATE_PAIRINGS.map(({ token, on }) => `${token} on ${on}`))

type Token = { variant: string, utility: string, family: 'fill' | 'pen' | 'edge', name: string }

function tokens(classes: string): Token[] {
  return classes.split(/\s+/).flatMap((cls) => {
    const match = cls.match(/^((?:[\w-]+|aria-\[[^\]]+\]):)?(bg|text|border(?:-[trblxy])?|divide|outline)-(fill|pen|edge)-([a-z]+-[a-z]+)$/)
    if (!match) return []
    return [{ variant: match[1] ?? '', utility: match[2]!, family: match[3] as Token['family'], name: `${match[3]}-${match[4]}` }]
  })
}

/** The fill each pen or edge is drawn on, by the guide's reading of one class string. */
function pairings(classes: string): string[] {
  const all = tokens(classes)
  const fill = (variant: string) =>
    all.find(t => t.family === 'fill' && t.variant === variant)?.name ?? all.find(t => t.family === 'fill' && t.variant === '')?.name ?? CARD
  return all
    .filter(t => t.family !== 'fill')
    .map(t => `${t.name} on ${t.utility === 'outline' ? CARD : fill(t.variant)}`)
}

const sameRoleAndState = (pairing: string) => {
  const [token, , surface] = pairing.split(' ')
  return token!.replace(/^(pen|edge)-/, '') === surface!.replace(/^fill-/, '')
}

describe('semantic presentation', () => {
  it('pairs pen and edge with a fill of the same role and state, or a listed deliberate pairing', () => {
    const offending = Object.entries(identityClasses).flatMap(([name, classes]) =>
      pairings(classes).filter(p => !sameRoleAndState(p) && !deliberate.has(p)).map(p => `${name}: ${p}`))
    expect(offending).toEqual([])
  })

  it('advances fill, pen and edge together through hover, active and disabled states', () => {
    const offending = Object.entries(identityClasses).flatMap(([name, classes]) => {
      const all = tokens(classes)
      const roles = (variant: string) => new Set(all.filter(t => t.variant === variant).map(t => `${t.family}-${t.name.split('-')[1]}`))
      const base = roles('')
      const missing = ['primaryButton', 'secondaryButton', 'dangerButton'].includes(name) ? ['hover:', 'active:', 'disabled:'].filter(v => roles(v).size === 0).map(v => `${name}: no ${v} state`) : []
      return missing.concat(['hover:', 'active:', 'disabled:'].flatMap((variant) => {
        const changed = roles(variant)
        if (changed.size === 0) return []
        return [...base].filter(r => !r.startsWith('edge-base') && !changed.has(r)).map(r => `${name}: ${r} has no ${variant} state`)
      }))
    })
    expect(offending).toEqual([])
  })

  it('uses every deliberate pairing and documents it for hosts', () => {
    const used = new Set(Object.values(identityClasses).flatMap(pairings))
    const contracts = readFileSync('docs/contracts.md', 'utf8')
    for (const { token, on } of DELIBERATE_PAIRINGS) {
      expect(used.has(`${token} on ${on}`), `${token} on ${on} unused`).toBe(true)
      expect(contracts, `${token} on ${on} undocumented`).toContain(`\`${token}\` on \`${on}\``)
    }
  })

  it('never reaches into Theme Manager private variables', () => {
    const files = [
      'tailwind.css',
      'playground/app/assets/css/main.css',
      ...['app', 'presentation'].flatMap(dir => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => /\.(vue|ts|css)$/.test(f)).map(f => join(dir, f))),
    ]
    const offending = files.filter(f => /--(ui|api|tm)-[a-z]/.test(readFileSync(f, 'utf8')))
    expect(offending).toEqual([])
  })

  it('resolves every utility to a Theme Manager token, never a Tailwind default', async () => {
    const classes = candidates()
    const css = await compileWithThemeManager(classes)
    const offGrammar = classes.filter((name) => {
      const escaped = name.replace(/[:./[\]=]/g, m => `\\${m}`)
      const rule = css.match(new RegExp(`\\.${escaped}(?::[a-z-]+)*\\s*\\{([^}]*)\\}`))?.[1]
      if (!rule) return false // not a utility (plain text in a string literal)
      return /calc\(var\(--spacing\)|--color-(?!fill-|pen-|edge-)[a-z]+-\d|--tracking-|--leading-|--default-font|\[/.test(rule)
    })
    expect(offGrammar).toEqual([])
  })

  it('names a semantic role (fill, pen or edge) in every colour utility', () => {
    const colour = /^(?:[a-z-]+:)*(?:bg|text|border|outline|divide|ring|fill|stroke|decoration|placeholder)-(?!fill-|pen-|edge-)(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/
    expect(candidates().filter(name => colour.test(name))).toEqual([])
  })
})

describe('presentation text', () => {
  const keys = new Set(Object.keys(IDENTITY_MESSAGES_EN_GB))
  const sources = globSync('presentation/**/*.{vue,ts}').map(file => readFileSync(file, 'utf8')).join('\n')

  it('defines every message key the pages use', () => {
    const used = [...sources.matchAll(/'(identity\.[a-zA-Z.-]+)'/g)].map(match => match[1]!).filter(key => !key.endsWith('.'))
    expect(used.filter(key => !keys.has(key))).toEqual([])
  })

  it('names every state, change type and error the pages may show', () => {
    const expected = [
      ...ERROR_CODES_FOR_TEST.map(code => `identity.error.${code}`),
      ...CHANGE_TYPES_FOR_TEST.map(type => `identity.changeType.${type}`),
      ...STATES_FOR_TEST,
    ]
    expect(expected.filter(key => !keys.has(key))).toEqual([])
  })

  it('keeps every message free of markup', () => {
    expect(Object.entries(IDENTITY_MESSAGES_EN_GB).filter(([, text]) => /<[a-z]/i.test(text)).map(([key]) => key)).toEqual([])
  })
})

describe('presentation boundary', () => {
  it('reaches the server only through useIdentity(), never $fetch or /api/ itself', () => {
    const offending = globSync('presentation/**/*.{vue,ts}').filter(file => /\$fetch|['"`]\/api\//.test(readFileSync(file, 'utf8')))
    expect(offending).toEqual([])
  })

  it('imports nothing from the server, and only the contract from the layer', () => {
    const offending = globSync('{presentation,modules}/**/*.{vue,ts}').flatMap((file) => {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]!)
      return imports.filter(path => /server\//.test(path) || (path.startsWith('..') && !/^(\.\.\/)+contracts$|^\.\.\/messages$|^\.\/useIdentityText$/.test(path))).map(path => `${file}: ${path}`)
    })
    expect(offending).toEqual([])
  })

  it('reads an invitation token from the fragment only, never the query or a route parameter', () => {
    const response = readFileSync('presentation/components/InvitationResponse.vue', 'utf8')
    expect(response).toContain('window.location.hash')
    expect(response).not.toMatch(/route\.(query|params)/)
  })
})

/** Every class-like token in the layer's string literals. */
function candidates(): string[] {
  const found = new Set<string>()
  for (const file of globSync('{app,presentation}/**/*.{vue,ts}')) {
    for (const literal of readFileSync(file, 'utf8').match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? []) {
      for (const token of literal.slice(1, -1).split(/\s+/)) {
        if (/^[a-z-]+(?::[a-z-[\]=]+)*:?[a-z0-9-./[\]]+$/.test(token)) found.add(token)
      }
    }
  }
  // Classes written in templates as plain attributes.
  for (const file of globSync('presentation/**/*.vue')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\sclass="([^"]+)"/g)) {
      for (const token of match[1]!.split(/\s+/)) found.add(token)
    }
  }
  return [...found]
}

/** Compiles classes against Theme Manager's public presentation.css export (never its private paths). */
async function compileWithThemeManager(classes: string[]): Promise<string> {
  const require = createRequire(import.meta.url)
  const { compile } = await import(require.resolve('@tailwindcss/node', { paths: [dirname(require.resolve('tailwindcss/package.json'))] }))
  const presentation = require.resolve('@nuxt4-layers/theme-manager/presentation.css')
  const compiler = await compile(`@import ${JSON.stringify(presentation)};`, { base: dirname(presentation), onDependency: () => {} })
  return compiler.build(classes)
}
