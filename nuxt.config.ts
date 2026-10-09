/**
 * Nuxt layer entry point for `@nuxt4-layers/identity`.
 *
 * Hosts compose this layer by package name from `extends` and supply the
 * required ports from a Nitro plugin. See docs/composition-contract.md.
 */
export default defineNuxtConfig({
  compatibilityDate: '2026-06-30',
  runtimeConfig: {
    identity: {
      /**
       * The host's public origin (`NUXT_IDENTITY_BASE_URL`). State-changing
       * `/api/identity/*` requests must come from it; without it they are
       * all refused.
       */
      baseUrl: '',
    },
  },
})
