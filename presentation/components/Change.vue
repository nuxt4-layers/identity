<script setup lang="ts">
/**
 * PUBLIC. A governance change, for whoever may see it: what it does, why,
 * how it is approved, and the actions open to the signed-in person
 * (approve or reject, cancel their own, object to a recovery). The approval
 * carries the digest of the change as shown, so an altered change is refused.
 */
const props = defineProps<{ changeId: string }>()
const identity = useIdentity()
const routes = useIdentityRoutes()
const { t, locale } = useIdentityText()
const action = useIdentityAction()
const notice = ref<string | null>(null)

const { data: change, error, refresh } = await useAsyncData(`identity-change-${props.changeId}`, () => identity.change(props.changeId))
const failure = computed(() => (error.value ? identityErrorOf(error.value)?.code ?? 'unavailable' : null))
const when = (instant: string | null) => (instant ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant)) : '')

async function act(run: () => Promise<unknown>, done: string) {
  notice.value = null
  if (await action.run(run)) {
    notice.value = t(done)
    await refresh()
  }
}
</script>

<template>
  <div :class="identityClasses.stack">
    <IdentityUnavailable v-if="failure" :code="failure" />
    <template v-else-if="change">
      <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
      <IdentityAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</IdentityAlert>
      <h2 :class="identityClasses.sectionTitle">{{ t(`identity.changeType.${change.type}`) }}</h2>
      <dl :class="identityClasses.definitions">
        <dt :class="identityClasses.term">{{ t('identity.change.state') }}</dt>
        <dd :class="identityClasses.definition"><span :class="identityClasses.badge">{{ t(`identity.changeState.${change.state}`) }}</span></dd>
        <dt :class="identityClasses.term">{{ t('identity.change.group') }}</dt>
        <dd :class="identityClasses.definition">
          <NuxtLink v-if="change.groupId" :to="routes.group(change.groupId)" :class="identityClasses.link">{{ t('identity.change.groupLink') }}</NuxtLink>
        </dd>
        <dt :class="identityClasses.term">{{ t('identity.change.requester') }}</dt>
        <dd :class="identityClasses.definition"><IdentityPersonName :identity-id="change.requesterId" /></dd>
        <template v-if="change.beneficiaryId">
          <dt :class="identityClasses.term">{{ t('identity.change.beneficiary') }}</dt>
          <dd :class="identityClasses.definition"><IdentityPersonName :identity-id="change.beneficiaryId" /></dd>
        </template>
        <dt :class="identityClasses.term">{{ t('identity.change.risk') }}</dt>
        <dd :class="identityClasses.definition">{{ t(`identity.risk.${change.risk}`) }}</dd>
        <dt :class="identityClasses.term">{{ t('identity.change.reason') }}</dt>
        <dd :class="identityClasses.definition"><code :class="identityClasses.code">{{ change.justification.reasonCode }}</code><template v-if="change.justification.reference"> · <code :class="identityClasses.code">{{ change.justification.reference }}</code></template></dd>
        <dt :class="identityClasses.term">{{ t('identity.change.route') }}</dt>
        <dd :class="identityClasses.definition">{{ t(`identity.route.${change.route}`, { count: change.requiredApprovals }) }}</dd>
        <template v-if="change.delayEndsAt">
          <dt :class="identityClasses.term">{{ t('identity.change.appliesAt') }}</dt>
          <dd :class="identityClasses.definition">{{ when(change.delayEndsAt) }}</dd>
        </template>
        <template v-if="change.expiresAt && change.state === 'awaiting-approval'">
          <dt :class="identityClasses.term">{{ t('identity.change.expiresAt') }}</dt>
          <dd :class="identityClasses.definition">{{ when(change.expiresAt) }}</dd>
        </template>
        <dt :class="identityClasses.term">{{ t('identity.change.digest') }}</dt>
        <dd :class="identityClasses.definition"><code :class="identityClasses.code">{{ change.changeDigest }}</code></dd>
      </dl>
      <div :class="identityClasses.row" class="mt-4">
        <template v-if="change.state === 'awaiting-approval'">
          <button type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="act(() => identity.decideChange(change!, 'approve'), 'identity.change.approved')">{{ t('identity.change.approve') }}</button>
          <button type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value" @click="act(() => identity.decideChange(change!, 'reject'), 'identity.change.rejected')">{{ t('identity.change.reject') }}</button>
        </template>
        <button v-if="change.type === 'group.appoint-owner' && change.state === 'delayed' && change.route === 'published-delay'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="act(() => identity.objectToChange(change!.changeId), 'identity.change.objected')">
          {{ t('identity.change.object') }}
        </button>
        <button v-if="change.state === 'awaiting-approval' || change.state === 'delayed'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="act(() => identity.cancelChange(change!.changeId), 'identity.change.cancelled')">
          {{ t('identity.change.cancel') }}
        </button>
      </div>
      <p :class="identityClasses.muted">{{ t('identity.change.serverDecides') }}</p>
    </template>
  </div>
</template>
