// Composition harness: proves the layer composes in a host. Not published.
export default defineNuxtConfig({
  extends: ['..'],
  nitro: {
    // How a host might schedule Identity's background work; any scheduler will do.
    experimental: { tasks: true },
    scheduledTasks: { '*/5 * * * *': ['identity:maintenance'] },
  },
})
