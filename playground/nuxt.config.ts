// Composition harness: proves the layer composes in a host. Not published.
export default defineNuxtConfig({
  // Composed as a host would: the identity layer and Theme Manager as peers.
  extends: ['..', '@nuxt4-layers/theme-manager'],
  css: ['~/assets/css/main.css'],
  compatibilityDate: '2026-06-30',
  nitro: {
    // How a host might schedule Identity's background work; any scheduler will do.
    experimental: { tasks: true },
    scheduledTasks: { '*/5 * * * *': ['identity:maintenance'] },
  },
})
