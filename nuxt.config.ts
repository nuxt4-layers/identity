/**
 * Nuxt layer entry point for `@nuxt4-layers/identity`.
 *
 * Hosts compose this layer by package name from `extends` and supply the
 * required ports from a Nitro plugin. See docs/composition-contract.md.
 */
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  compatibilityDate: '2026-06-30',

  // Presentation (default pages and components), registered only when
  // `identity.presentation` is true. The core below never depends on it.
  modules: [fileURLToPath(new URL('./modules/presentation', import.meta.url))],

  runtimeConfig: {
    identity: {
      /**
       * The host's public origin (`NUXT_IDENTITY_BASE_URL`). State-changing
       * `/api/identity/*` requests must come from it; without it they are
       * all refused.
       */
      baseUrl: '',
    },
    public: {
      identity: {
        /** BCP 47 locale of the pages' text (`NUXT_PUBLIC_IDENTITY_LOCALE`). */
        locale: 'en-GB',
        /** Where the pages link. The presentation module fills in its own page paths; hosts set `signIn`. */
        routes: {
          signIn: '/sign-in',
          account: '/account/groups',
          group: '/groups/:groupId',
          invitation: '/invitations/accept',
          change: '/changes/:changeId',
        },
      },
    },
  },
})
