import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { ORIGIN } from './constants'

/**
 * The default pages in a real browser, against the built playground with
 * Theme Manager's real styles: the journeys, keyboard-only use, reflow, and
 * axe checks against the WCAG 2.2 AA rules.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

interface Scenario {
  tenantId: string
  root: string
  team: string
  rootOwner: string
  owner: string
  member: string
  invitee: string
  outsider: string
  guestToken: string
  changeId: string
}

async function seed(request: APIRequestContext): Promise<Scenario> {
  const response = await request.post('/api/__playground/seed')
  expect(response.ok()).toBe(true)
  return response.json()
}

/** Stands in for Authentication: the playground reads the signed-in identity from this cookie in test mode. */
async function signInAs(context: BrowserContext, identityId: string) {
  await context.clearCookies()
  await context.addCookies([{ name: 'identity_playground_principal', value: identityId, url: ORIGIN }])
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
}

/**
 * WCAG 1.4.11 (non-text contrast), which axe does not check: a text field's
 * border and the keyboard focus indicator need 3:1 against their surface.
 */
async function expectNonTextContrast(page: Page, selector: string) {
  const ratios = await page.evaluate((target) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const luminance = (value: string) => {
      const [r, g, b] = parse(value).map((c) => {
        const v = c / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const ratio = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
      return (x! + 0.05) / (y! + 0.05)
    }
    const surface = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const colour = getComputedStyle(node).backgroundColor
        if (colour !== 'rgba(0, 0, 0, 0)') return colour
      }
      return 'rgb(255, 255, 255)'
    }
    const input = document.querySelector(target) as HTMLInputElement
    input.focus()
    const style = getComputedStyle(input)
    return {
      border: ratio(style.borderTopColor, surface(input)),
      focus: ratio(style.outlineColor, surface(input)),
      focusVisible: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
    }
  }, selector)
  expect(ratios.focusVisible).toBe(true)
  expect(ratios.border).toBeGreaterThanOrEqual(3)
  expect(ratios.focus).toBeGreaterThanOrEqual(3)
}

async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('asks a signed-out visitor to sign in, and returns them afterwards', async ({ page, context }) => {
  await context.clearCookies()
  await page.goto('/account/groups')
  const link = page.getByRole('link', { name: 'Sign in' })
  await expect(link).toHaveAttribute('href', '/sign-in?redirect=%2Faccount%2Fgroups')
  await expectAccessible(page)
})

test('protects every page from framing, caching and referrer leaks', async ({ request }) => {
  for (const path of ['/account/groups', '/groups/01a120c9-2cd1-784a-a3d6-f725b2cb2eab', '/invitations/accept', '/changes/01a120c9-2cd1-784a-a3d6-f725b2cb2eab']) {
    const response = await request.get(path)
    expect(response.headers()['x-frame-options'], path).toBe('DENY')
    expect(response.headers()['cache-control'], path).toBe('no-store')
    expect(response.headers()['referrer-policy'], path).toBe('no-referrer')
  }
})

test('shows a member their groups, and lets them pause and resume a membership by keyboard', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.member)
  await page.goto('/account/groups')
  await expect(page.getByRole('heading', { level: 1, name: 'Your groups and account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Team' })).toBeVisible()
  await expectAccessible(page)

  await page.getByRole('button', { name: 'Pause', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Your membership is paused.' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Team' }).getByText('Paused')).toBeVisible()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your membership is active again.' })).toBeVisible()
  await expectAccessible(page)
})

test('explains why a sole owner cannot leave, in words, after asking to confirm', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.owner)
  await page.goto('/account/groups')
  await page.getByRole('listitem').filter({ hasText: 'Team' }).getByRole('button', { name: 'Leave' }).click()
  await page.getByRole('button', { name: 'Leave Team' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('A group needs at least one active owner. Appoint another owner first.')
  await expect(alert).toBeFocused()
  await expectAccessible(page)
})

test('shows an owner the group, its members, invitations and changes, and renames it', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.owner)
  await page.goto(`/groups/${scenario.team}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Team' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Invitations' })).toBeVisible()
  await expect(page.getByText('Waiting', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add an owner' })).toHaveAttribute('href', `/changes/${scenario.changeId}`)
  await expectAccessible(page)
  await expectNonTextContrast(page, '#identity-child-name')

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('New name').fill('Platform Team')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Platform Team' })).toBeVisible()
  await expectAccessible(page)

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('New name').fill('Pay​roll')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('alert')).toHaveText('The name contains a character that is not allowed.')
})

test('reflows to 320 CSS pixels without scrolling sideways', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.owner)
  await page.setViewportSize({ width: 320, height: 800 })
  for (const path of ['/account/groups', `/groups/${scenario.team}`, `/changes/${scenario.changeId}`]) {
    await page.goto(path)
    await expectNoHorizontalScroll(page)
  }
})

test('lets an invited guest accept from the link\'s fragment, and the owner confirm who accepted', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.invitee)
  await page.goto(`/invitations/accept#${scenario.guestToken}`)
  await expectAccessible(page)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('status')).toContainText('Thank you.')
  expect(new URL(page.url()).hash).toBe('')
  await expectAccessible(page)

  await signInAs(context, scenario.owner)
  await page.goto(`/groups/${scenario.team}`)
  const invitation = page.getByRole('listitem').filter({ hasText: 'Accepted, needs confirmation' })
  await expect(invitation).toBeVisible()
  await invitation.getByRole('button', { name: 'Confirm' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Accepted' }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Members' }).getByText('Guest')).toBeVisible()
})

test('answers a forged or missing invitation link alike', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.invitee)
  await page.goto('/invitations/accept')
  await expect(page.getByRole('status')).toHaveText('Open the link from your invitation to respond to it.')
  await page.goto(`/invitations/accept#${'F'.repeat(43)}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page.getByRole('status')).toContainText('Thank you.')
})

test('lets the approver approve a change, showing what they approve', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.rootOwner)
  await page.goto(`/changes/${scenario.changeId}`)
  await expect(page.getByRole('heading', { level: 2, name: 'Add an owner' })).toBeVisible()
  await expect(page.getByText('An owner of the group above')).toBeVisible()
  await expectAccessible(page)
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your approval has been recorded.' })).toBeVisible()
  await expect(page.getByText('Applied', { exact: true })).toBeVisible()
  await expectAccessible(page)
})

test('tells someone outside a group only that it is not available, and offers to ask to join', async ({ page, context, request }) => {
  const scenario = await seed(request)
  await signInAs(context, scenario.outsider)
  await page.goto(`/groups/${scenario.team}`)
  await expect(page.getByText('This is not available to you.')).toBeVisible()
  // An unknown group reads the same.
  await page.goto('/groups/01a120c9-2cd1-784a-a3d6-f725b2cb2eab')
  await expect(page.getByText('This is not available to you.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask to join' })).toBeVisible()
  await expectAccessible(page)
})
