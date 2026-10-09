<script setup lang="ts">
useHead({ title: 'Identity playground', htmlAttrs: { lang: 'en-GB' } })
</script>

<template>
  <div :class="identityClasses.page">
    <main :class="identityClasses.card">
      <h1 :class="identityClasses.title">Identity playground</h1>
      <p :class="identityClasses.text">Composition harness for the identity layer.</p>
      <p class="mt-4"><NuxtLink to="/account/groups" :class="identityClasses.actionLink">Your groups and account</NuxtLink></p>
    </main>
  </div>
</template>
