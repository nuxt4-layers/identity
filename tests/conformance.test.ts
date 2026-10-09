import { describe, expect, it } from 'vitest'
import { identityDirectoryConformance } from '../conformance'
import type { MemoryDirectoryOptions } from './support/memory-directory'
import { MemorySource, memoryDirectory, memoryFixture } from './support/memory-directory'

function subject(options: MemoryDirectoryOptions = {}) {
  const source = new MemorySource()
  return { directory: memoryDirectory(source, options), fixture: memoryFixture(source), boundedStalenessSeconds: options.stalenessSeconds ?? 30 }
}

describe('directory conformance suite (improvement register item 1)', () => {
  for (const check of identityDirectoryConformance(subject())) {
    it(`a correct directory: ${check.name}`, () => check.run())
  }

  async function failures(options: MemoryDirectoryOptions): Promise<string[]> {
    const failed: string[] = []
    for (const check of identityDirectoryConformance(subject(options))) {
      try {
        await check.run()
      }
      catch {
        failed.push(check.name)
      }
    }
    return failed
  }

  it.each([
    ['answers null instead of failing', 'null-on-failure', /when the source fails/],
    ['serves strong reads from its cache', 'cache-strong-reads', /at once on a strong read/],
    ['never expires its cache', 'never-expire-cache', /once the bound has passed/],
    ['ignores the identity\'s own state', 'ignore-identity-state', /paused identity/],
    ['lists memberships that have not started', 'list-not-started', /not yet started/],
  ] as const)('catches a directory that %s', async (_label, fault, expected) => {
    const failed = await failures({ fault })
    expect(failed.some(name => expected.test(name)), failed.join('; ')).toBe(true)
  })

  it('catches a directory whose staleness bound exceeds the contract\'s', async () => {
    expect(await failures({ stalenessSeconds: 60 })).toContain('declares a bounded staleness no greater than the contract allows')
  })
})
