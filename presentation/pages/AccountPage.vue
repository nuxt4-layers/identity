<script setup lang="ts">
/** Default page provided by @nuxt4-layers/identity. Disable with identity.pages.enabled = false. */

const { t, locale } = useIdentityText()
useHead({ title: t('identity.account.title'), htmlAttrs: { lang: locale } })
</script>

<template>
  <div :class="identityClasses.page">
    <main :class="identityClasses.card" aria-labelledby="identity-page-title">
      <h1 id="identity-page-title" :class="identityClasses.title">{{ t('identity.account.title') }}</h1>
      <IdentityAccount />
    </main>
  </div>
</template>
