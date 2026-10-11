<script setup lang="ts">
/**
 * PUBLIC. The service identities a group owns (`identity.service-identities:manage`):
 * each one's name, state and how many groups it belongs to, with renaming.
 * Nothing when refused or empty. Their credentials are Authentication's.
 */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const { t } = useIdentityText()
const action = useIdentityAction()
const { data: list, error, refresh } = await useAsyncData(`identity-service-identities-${props.groupId}`, () => identity.serviceIdentities(props.groupId))
const editing = ref<string | null>(null)
const name = ref('')

function edit(identityId: string, current: string | null) {
  editing.value = identityId
  name.value = current ?? ''
}

async function rename(identityId: string) {
  if (await action.run(() => identity.renameServiceIdentity(identityId, name.value))) {
    editing.value = null
    await refresh()
  }
}
</script>

<template>
  <section v-if="!error && list && list.serviceIdentities.length > 0" :class="identityClasses.section" aria-labelledby="identity-service-identities-title">
    <h2 id="identity-service-identities-title" :class="identityClasses.sectionTitle">{{ t('identity.serviceIdentities.title') }}</h2>
    <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
    <ul :class="identityClasses.list">
      <li v-for="service in list.serviceIdentities" :key="service.identityId" :class="identityClasses.listItem">
        <div :class="identityClasses.row">
          <span :class="identityClasses.text">{{ service.name ?? t('identity.serviceIdentities.unnamed') }}</span>
          <span :class="identityClasses.badge">{{ t(`identity.state.${service.state}`) }}</span>
          <span :class="identityClasses.muted">{{ t('identity.serviceIdentities.groups', { count: service.groupIds.length }) }}</span>
        </div>
        <form v-if="editing === service.identityId" :class="identityClasses.row" @submit.prevent="rename(service.identityId)">
          <label :for="`identity-service-name-${service.identityId}`" :class="identityClasses.label">{{ t('identity.serviceIdentities.name') }}</label>
          <input :id="`identity-service-name-${service.identityId}`" v-model="name" :class="identityClasses.input" type="text" maxlength="100" required>
          <button type="submit" :class="identityClasses.primaryButton" :disabled="action.disabled.value">{{ t('identity.serviceIdentities.save') }}</button>
          <button type="button" :class="identityClasses.secondaryButton" @click="editing = null">{{ t('identity.serviceIdentities.cancel') }}</button>
        </form>
        <div v-else-if="service.state !== 'closed'" :class="identityClasses.row">
          <button type="button" :class="identityClasses.secondaryButton" @click="edit(service.identityId, service.name)">{{ t('identity.serviceIdentities.rename') }}</button>
        </div>
      </li>
    </ul>
  </section>
</template>
