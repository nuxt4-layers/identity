<script setup lang="ts">
/** PUBLIC. A group's open join requests (`identity.join-requests:decide`); nothing when refused or empty. */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const { t } = useIdentityText()
const action = useIdentityAction()
const { data: requests, error, refresh } = await useAsyncData(`identity-join-requests-${props.groupId}`, () => identity.joinRequests(props.groupId))

async function decide(joinRequestId: string, decision: 'approve' | 'refuse') {
  // An approved request adds a member, so the members section is refreshed too.
  if (await action.run(() => identity.decideJoinRequest(joinRequestId, decision))) await Promise.all([refresh(), refreshNuxtData(`identity-members-${props.groupId}`)])
}
</script>

<template>
  <section v-if="!error && requests && requests.length > 0" :class="identityClasses.section" aria-labelledby="identity-join-requests-title">
    <h2 id="identity-join-requests-title" :class="identityClasses.sectionTitle">{{ t('identity.joinRequests.title') }}</h2>
    <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
    <ul :class="identityClasses.list">
      <li v-for="request in requests" :key="request.joinRequestId" :class="identityClasses.listItem">
        <IdentityPersonName :identity-id="request.identityId" />
        <div :class="identityClasses.row">
          <button type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="decide(request.joinRequestId, 'approve')">{{ t('identity.joinRequests.approve') }}</button>
          <button type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value" @click="decide(request.joinRequestId, 'refuse')">{{ t('identity.joinRequests.refuse') }}</button>
        </div>
      </li>
    </ul>
  </section>
</template>
