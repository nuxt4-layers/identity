import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(resolve(root, 'capability.json'), 'utf8'))

describe('Identity repository foundation', () => {
  it('keeps package and capability manifest identity and version aligned', () => {
    expect(manifest.name).toBe(pkg.name)
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.classification).toBe('foundation')
  })

  it('publishes deliberate root, contracts, conformance, capability and presentation entry points', () => {
    expect(pkg.exports).toEqual({
      '.': './nuxt.config.ts',
      './contracts': './contracts/index.ts',
      './conformance': './conformance/index.ts',
      './capability': './capability.json',
      './presentation': './presentation/index.ts',
      './tailwind.css': './tailwind.css',
    })
    expect(manifest.publicExports).toEqual(Object.keys(pkg.exports))
  })

  it('provides the Identity contract and requires Authorisation and Authentication by contract only', () => {
    expect(manifest.provides).toEqual([{ capability: 'Identity', contractVersion: '1' }])
    expect(manifest.requires.map((r: { capability: string }) => r.capability)).toEqual(['Authorisation', 'Authentication', 'SemanticPresentationTheme'])
    expect(Object.keys(pkg.dependencies ?? {}).filter(name => name.startsWith('@nuxt4-layers/'))).toEqual([])
  })

  it('declares database, access decision, approval policy and event publisher as required ports', () => {
    const required = manifest.ports.filter((p: { optional: boolean }) => !p.optional).map((p: { port: string }) => p.port)
    expect(required).toEqual(['IdentityDatabase', 'IdentityAccessDecision', 'IdentityApprovalPolicy', 'IdentityEventPublisher'])
  })

  it('declares the ports it provides to Authentication, Authorisation and Profile', () => {
    expect(manifest.providesPorts.map((p: { port: string }) => p.port)).toEqual(['IdentityProvisioning', 'IdentityDirectory', 'IdentityDisclosureContextPort'])
  })

  it('depends on zod alone at runtime', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['zod'])
    expect(pkg.peerDependencies).toHaveProperty('nuxt')
  })

  it('runs no install-time scripts, so Git installs pull no devDependencies', () => {
    expect(pkg.scripts).not.toHaveProperty('prepare')
    expect(pkg.scripts).not.toHaveProperty('postinstall')
    expect(pkg.scripts).not.toHaveProperty('install')
  })
})
