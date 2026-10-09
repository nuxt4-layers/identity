<script setup lang="ts">
/**
 * PUBLIC. How the pages name a person or service identity. Identity holds no
 * names (Profile does), so by default this shows a short, stable label made
 * from the opaque identifier. A host replaces it with its own component named
 * `IdentityPersonName`, taking the same `identityId` prop, that asks Profile
 * through its disclosure rules.
 */
const props = defineProps<{ identityId: string }>()
const { t } = useIdentityText()
const label = computed(() => t('identity.person.label', { short: props.identityId.slice(-6) }))
</script>

<template>
  <span :title="identityId">{{ label }}</span>
</template>
