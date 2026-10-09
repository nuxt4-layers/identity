<script setup lang="ts">
/** PUBLIC. What a section shows when it cannot load: signed out, not allowed (or not there: the server does not say which), or a failure. */
const props = defineProps<{ code: string }>()
const { t } = useIdentityText()
const known = computed(() => ['forbidden', 'unavailable', 'insufficient-assurance', 'rate-limited'].includes(props.code) ? props.code : 'unavailable')
</script>

<template>
  <IdentitySignedOut v-if="code === 'unauthenticated'" />
  <IdentityAlert v-else :tone="known === 'forbidden' ? 'info' : 'error'" :focus-on-mount="false">
    <p>{{ t(`identity.error.${known}`) }}</p>
  </IdentityAlert>
</template>
