<script setup lang="ts">
/**
 * PUBLIC. A group: its name, place and state, and the sections the signed-in
 * person may see (members, invitations, join requests, pending changes).
 * Each section asks the server and shows nothing it is refused.
 */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const routes = useIdentityRoutes()
const { t } = useIdentityText()
const action = useIdentityAction()
const notice = ref<string | null>(null)
const renaming = ref(false)
const newName = ref('')
const childName = ref('')

const { data: view, error, refresh } = await useAsyncData(`identity-group-${props.groupId}`, () => identity.group(props.groupId))
const failure = computed(() => (error.value ? identityErrorOf(error.value)?.code ?? 'unavailable' : null))
const group = computed(() => view.value?.group)
const parentId = computed(() => (view.value && view.value.lineage.length > 1 ? view.value.lineage.at(-2)! : null))

async function rename() {
  const result = await action.run(() => identity.renameGroup(props.groupId, newName.value))
  if (result) {
    renaming.value = false
    notice.value = t('identity.group.renamed')
    await refresh()
  }
}

async function createChild() {
  const result = await action.run(() => identity.createGroup(props.groupId, childName.value))
  if (result) await navigateTo(routes.group(result.groupId))
}

async function join() {
  const result = await action.run(() => identity.joinGroup(props.groupId))
  if (result) notice.value = t(result.outcome === 'joined' ? 'identity.group.joined' : 'identity.group.requested')
}
</script>

<template>
  <div :class="identityClasses.stack">
    <template v-if="failure">
      <IdentityUnavailable :code="failure" />
      <div v-if="failure === 'forbidden'" :class="identityClasses.stack">
        <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
        <IdentityAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</IdentityAlert>
        <p :class="identityClasses.text">{{ t('identity.group.joinExplained') }}</p>
        <div>
          <button type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="join">{{ t('identity.group.join') }}</button>
        </div>
      </div>
    </template>
    <template v-else-if="group">
      <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
      <IdentityAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</IdentityAlert>

      <section aria-labelledby="identity-group-about">
        <h2 id="identity-group-about" :class="identityClasses.sectionTitle">{{ group.name }}</h2>
        <dl :class="identityClasses.definitions">
          <dt :class="identityClasses.term">{{ t('identity.group.state') }}</dt>
          <dd :class="identityClasses.definition"><span :class="identityClasses.badge">{{ t(`identity.groupState.${group.state}`) }}</span></dd>
          <dt :class="identityClasses.term">{{ t('identity.group.parent') }}</dt>
          <dd :class="identityClasses.definition">
            <NuxtLink v-if="parentId" :to="routes.group(parentId)" :class="identityClasses.link">{{ t('identity.group.parentLink') }}</NuxtLink>
            <span v-else>{{ t('identity.group.root') }}</span>
          </dd>
          <dt :class="identityClasses.term">{{ t('identity.group.identifier') }}</dt>
          <dd :class="identityClasses.definition"><code :class="identityClasses.code">{{ group.groupId }}</code></dd>
        </dl>
        <IdentityAlert v-if="group.state === 'orphaned'" tone="warning" :focus-on-mount="false" class="mt-4">
          <p>{{ t('identity.group.orphanedNotice') }}</p>
        </IdentityAlert>

        <form v-if="renaming" :class="identityClasses.stack" class="mt-4" novalidate @submit.prevent="rename">
          <div>
            <label for="identity-group-name" :class="identityClasses.label">{{ t('identity.group.newName') }}</label>
            <input id="identity-group-name" v-model="newName" type="text" maxlength="100" required autocomplete="off" :class="identityClasses.input" :aria-invalid="action.code.value === 'validation-failed'">
            <p :class="identityClasses.hint">{{ t('identity.group.nameHint') }}</p>
          </div>
          <div :class="identityClasses.row">
            <button type="submit" :class="identityClasses.primaryButton" :disabled="action.disabled.value || !newName.trim()">{{ t('identity.group.saveName') }}</button>
            <button type="button" :class="identityClasses.secondaryButton" @click="renaming = false">{{ t('identity.common.cancel') }}</button>
          </div>
        </form>
        <div v-else-if="group.state === 'active'" :class="identityClasses.row" class="mt-4">
          <button type="button" :class="identityClasses.secondaryButton" @click="renaming = true; newName = group.name ?? ''">{{ t('identity.group.rename') }}</button>
        </div>
      </section>

      <IdentityMembers :group-id="groupId" />
      <IdentityInvitations :group-id="groupId" />
      <IdentityJoinRequests :group-id="groupId" />
      <IdentityChanges :group-id="groupId" />
      <IdentitySafetyPeriods :group-id="groupId" :periods="view!.safetyPeriods" :active="group.state === 'active'" @requested="notice = t('identity.safety.requested')" />

      <section v-if="group.state === 'active'" :class="identityClasses.section" aria-labelledby="identity-group-child">
        <h2 id="identity-group-child" :class="identityClasses.sectionTitle">{{ t('identity.group.childTitle') }}</h2>
        <form :class="identityClasses.stack" novalidate @submit.prevent="createChild">
          <div>
            <label for="identity-child-name" :class="identityClasses.label">{{ t('identity.group.childName') }}</label>
            <input id="identity-child-name" v-model="childName" type="text" maxlength="100" required autocomplete="off" :class="identityClasses.input">
            <p :class="identityClasses.hint">{{ t('identity.group.nameHint') }}</p>
          </div>
          <div>
            <button type="submit" :class="identityClasses.primaryButton" :disabled="action.disabled.value || !childName.trim()">{{ t('identity.group.createChild') }}</button>
          </div>
        </form>
      </section>
    </template>
  </div>
</template>
