<script setup lang="ts">
/** Default page provided by @nuxt4-layers/identity. Disable with identity.pages.enabled = false. */
const route = useRoute()
const changeId = computed(() => String(route.params.changeId))
const { t, locale } = useIdentityText()
useHead({ title: t('identity.change.title'), htmlAttrs: { lang: locale } })
</script>

<template>
  <div :class="identityClasses.page">
    <main :class="identityClasses.card" aria-labelledby="identity-page-title">
      <h1 id="identity-page-title" :class="identityClasses.title">{{ t('identity.change.title') }}</h1>
      <IdentityChange :key="changeId" :change-id="changeId" />
    </main>
  </div>
</template>
