import { describe, expect, it } from 'vitest'
import { checkSafeName, confusableSkeleton, safeGroupNameSchema } from '../contracts'

describe('safe names (improvement register item 6)', () => {
  it('normalises to NFC, trims and collapses spaces', () => {
    expect(checkSafeName('  Café   Club ')).toEqual({ ok: true, value: 'Café Club' })
    expect(checkSafeName('North Team')).toEqual({ ok: true, value: 'North Team' })
  })

  it('accepts ordinary names in many scripts', () => {
    for (const name of ['Sales', 'Ventes & Marketing', 'Отдел продаж', 'Ομάδα 2', 'فريق المبيعات', 'מחלקה', '営業部カタカナ', 'R&D 東京', '영업팀', 'Équipe 7 — Paris']) {
      expect(checkSafeName(name).ok, name).toBe(true)
    }
  })

  it.each([
    ['zero-width space', 'Admin​s'],
    ['right-to-left override', 'abc‮gpj.exe'],
    ['control character', 'Team\u0007'],
    ['line separator', 'Team Two'],
    ['private use', 'Team'],
    ['byte-order mark', '﻿Team'],
  ])('refuses a %s', (_label, name) => {
    expect(checkSafeName(name)).toEqual({ ok: false, problem: 'forbidden-character' })
  })

  it('refuses mixed-script look-alikes such as Cyrillic letters inside a Latin name', () => {
    expect(checkSafeName('Аcme')).toEqual({ ok: false, problem: 'mixed-script' })
    expect(checkSafeName('Paypаl')).toEqual({ ok: false, problem: 'mixed-script' })
    expect(checkSafeName('Team Ωmega')).toEqual({ ok: false, problem: 'mixed-script' })
  })

  it('refuses empty and over-long names', () => {
    expect(checkSafeName('   ')).toEqual({ ok: false, problem: 'empty' })
    expect(checkSafeName('a'.repeat(101))).toEqual({ ok: false, problem: 'too-long' })
    expect(checkSafeName('a'.repeat(100)).ok).toBe(true)
  })

  it('gives whole-script look-alikes the same skeleton, so siblings can be refused', () => {
    expect(confusableSkeleton('Асме')).toBe(confusableSkeleton('Acme'))
    expect(confusableSkeleton('PAYPAL')).toBe(confusableSkeleton('paypa1'))
    expect(confusableSkeleton('Mod Team')).toBe(confusableSkeleton('rnod team'))
    expect(confusableSkeleton('Sales')).not.toBe(confusableSkeleton('Sells'))
  })

  it('reports the problem code from the schema, for localisation', () => {
    const result = safeGroupNameSchema.safeParse('Admin​s')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('forbidden-character')
    expect(safeGroupNameSchema.parse(' Sales ')).toBe('Sales')
  })
})
