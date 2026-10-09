import { addComponentsDir, addImportsDir, createResolver, defineNuxtModule, extendPages } from 'nuxt/kit'

/**
 * Registers the layer's presentation: the default pages, the `Identity*`
 * components and the presentation auto-imports (`useIdentityText`,
 * `useIdentityAction`, `useIdentityRoutes`, `identityClasses`). The core
 * (server, endpoints and `useIdentity()`) never depends on any of it.
 *
 * Hosts configure it in nuxt.config.ts:
 *   identity: { pages: { paths: { account: '/me/groups' } } }  // move the pages
 *   identity: { pages: { enabled: false } }                    // own pages, keep the components
 *   identity: { presentation: false }                          // core only: register nothing here
 */
export interface IdentityPagePaths {
  account: string
  /** Must contain `:groupId`. */
  group: string
  invitation: string
  /** Must contain `:changeId`. */
  change: string
}

export interface IdentityModuleOptions {
  /** `false` registers no pages, components or presentation auto-imports. */
  presentation: boolean
  pages: {
    enabled: boolean
    paths: IdentityPagePaths
  }
}

const PAGES: { key: keyof IdentityPagePaths, file: string, parameter?: string }[] = [
  { key: 'account', file: 'AccountPage.vue' },
  { key: 'group', file: 'GroupPage.vue', parameter: ':groupId' },
  { key: 'invitation', file: 'InvitationPage.vue' },
  { key: 'change', file: 'ChangePage.vue', parameter: ':changeId' },
]

export default defineNuxtModule<IdentityModuleOptions>({
  meta: { name: '@nuxt4-layers/identity/presentation', configKey: 'identity' },
  defaults: {
    presentation: true,
    pages: {
      enabled: true,
      paths: {
        account: '/account/groups',
        group: '/groups/:groupId',
        invitation: '/invitations/accept',
        change: '/changes/:changeId',
      },
    },
  },
  setup(options, nuxt) {
    if (!options.presentation) return

    const { resolve } = createResolver(import.meta.url)
    addComponentsDir({ path: resolve('../presentation/components'), prefix: 'Identity', pathPrefix: false })
    addImportsDir([resolve('../presentation/composables'), resolve('../presentation/utils')])
    // Type-check the presentation sources with the host's app code.
    nuxt.hook('prepare:types', ({ tsConfig }) => {
      const include = (tsConfig.include ??= [])
      include.push(resolve('../presentation/**/*'))
    })

    if (!options.pages.enabled) return
    for (const page of PAGES) {
      const path = options.pages.paths[page.key]
      if (!path.startsWith('/') || path.startsWith('//')) {
        throw new Error(`identity.pages.paths.${page.key} must be an absolute path, got '${path}'.`)
      }
      if (page.parameter && !path.includes(page.parameter)) {
        throw new Error(`identity.pages.paths.${page.key} must contain '${page.parameter}', got '${path}'.`)
      }
    }
    // The pages link to one another through the public routes.
    const runtimeRoutes = (nuxt.options.runtimeConfig.public as { identity: { routes: Record<string, string> } }).identity.routes
    Object.assign(runtimeRoutes, options.pages.paths)

    // The pages act for the signed-in person: never framed (clickjacking),
    // never cached, never leaking a path in a Referer. Headers a host sets for
    // the same path take precedence.
    const routeRules = (nuxt.options.routeRules ??= {}) as Record<string, { headers?: Record<string, string> }>
    for (const path of Object.values(options.pages.paths)) {
      const pattern = path.replace(/:\w+/g, '**')
      const rule = (routeRules[pattern] ??= {})
      rule.headers = {
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        ...rule.headers,
      }
    }

    extendPages((pages) => {
      for (const page of PAGES) {
        pages.push({ name: `identity-${page.key}`, path: options.pages.paths[page.key], file: resolve('../presentation/pages', page.file) })
      }
    })
  },
})
