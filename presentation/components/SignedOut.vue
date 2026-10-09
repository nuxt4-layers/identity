<script setup lang="ts">
/** PUBLIC. Shown when nobody is signed in: a link to the host's sign-in page that returns here. */
const { t } = useIdentityText()
const routes = useIdentityRoutes()
const route = useRoute()
const href = computed(() => `${routes.signIn()}?redirect=${encodeURIComponent(route.fullPath)}`)
</script>

<template>
  <IdentityAlert tone="info" :focus-on-mount="false">
    <p>{{ t('identity.common.signInRequired') }}</p>
    <p class="mt-2">
      <a :href="href" :class="identityClasses.actionLink">{{ t('identity.common.signIn') }}</a>
    </p>
  </IdentityAlert>
</template>
