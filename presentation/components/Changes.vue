<script setup lang="ts">
/** PUBLIC. A group's pending governance changes, each linking to its own page; nothing when refused or empty. */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const routes = useIdentityRoutes()
const { t } = useIdentityText()
const { data: changes, error } = await useAsyncData(`identity-changes-${props.groupId}`, () => identity.changes(props.groupId))
</script>

<template>
  <section v-if="!error && changes && changes.length > 0" :class="identityClasses.section" aria-labelledby="identity-changes-title">
    <h2 id="identity-changes-title" :class="identityClasses.sectionTitle">{{ t('identity.changes.title') }}</h2>
    <ul :class="identityClasses.list">
      <li v-for="change in changes" :key="change.changeId" :class="identityClasses.listItem">
        <NuxtLink :to="routes.change(change.changeId)" :class="identityClasses.link">{{ t(`identity.changeType.${change.type}`) }}</NuxtLink>
        <span :class="identityClasses.badge">{{ t(`identity.changeState.${change.state}`) }}</span>
      </li>
    </ul>
  </section>
</template>
