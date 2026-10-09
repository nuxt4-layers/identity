/**
 * Example of the host scheduling Identity's background work (docs/composition-contract.md §4).
 * Maintenance and the outbox relay are idempotent and safe to run on several instances.
 */
export default defineTask({
  meta: { name: 'identity:maintenance', description: 'Expire what has run out of time, then relay the outbox' },
  async run() {
    const maintenance = await runIdentityMaintenance()
    const relay = await relayIdentityOutbox({ limit: 100 })
    return { result: { ...maintenance, ...relay } }
  },
})
