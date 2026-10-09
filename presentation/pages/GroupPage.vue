<script setup lang="ts">
/** Default page provided by @nuxt4-layers/identity. Disable with identity.pages.enabled = false. */
const route = useRoute()
const groupId = computed(() => String(route.params.groupId))
const { t, locale } = useIdentityText()
useHead({ title: t('identity.group.title'), htmlAttrs: { lang: locale } })
</script>

<template>
  <div :class="identityClasses.page">
    <main :class="identityClasses.card" aria-labelledby="identity-page-title">
      <h1 id="identity-page-title" :class="identityClasses.title">{{ t('identity.group.title') }}</h1>
      <IdentityGroup :key="groupId" :group-id="groupId" />
    </main>
  </div>
</template>
