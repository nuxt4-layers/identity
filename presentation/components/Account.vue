<script setup lang="ts">
/**
 * PUBLIC. The signed-in person's own page: their account state, the groups
 * they belong to, and the actions that are theirs alone (pausing, resuming,
 * leaving, closing). Nobody can do these for another person.
 */
const identity = useIdentity()
const routes = useIdentityRoutes()
const { t } = useIdentityText()
const action = useIdentityAction()
const notice = ref<string | null>(null)
const confirming = ref<'pause' | 'close' | `leave:${string}` | null>(null)
const leaveOrphaned = ref(false)

const { data: me, error, refresh } = await useAsyncData('identity-me', () => identity.me())
const failure = computed(() => (error.value ? identityErrorOf(error.value)?.code ?? 'unavailable' : null))
const memberships = computed(() => me.value?.actor.memberships ?? [])
const nameOf = (groupId: string) => me.value?.groupNames.find(entry => entry.groupId === groupId)?.name ?? t('identity.group.unnamed')
const state = computed(() => me.value?.actor.identityState)

async function act(run: () => Promise<unknown>, done: string) {
  notice.value = null
  const result = await action.run(run)
  if (result !== null) {
    confirming.value = null
    notice.value = t(done)
    await refresh()
  }
}
</script>

<template>
  <div :class="identityClasses.stack">
    <IdentityUnavailable v-if="failure" :code="failure" />
    <template v-else-if="me">
      <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
      <IdentityAlert v-if="notice" tone="success" :focus-on-mount="false">{{ notice }}</IdentityAlert>

      <section aria-labelledby="identity-account-state">
        <h2 id="identity-account-state" :class="identityClasses.sectionTitle">{{ t('identity.account.stateTitle') }}</h2>
        <p :class="identityClasses.text">
          {{ t('identity.account.state') }} <span :class="identityClasses.badge">{{ t(`identity.state.${state}`) }}</span>
        </p>
        <IdentityAlert v-if="state === 'paused'" tone="warning" :focus-on-mount="false" class="mt-3">
          <p>{{ t('identity.account.pausedNotice') }}</p>
        </IdentityAlert>
        <IdentityAlert v-if="state === 'closure-pending'" tone="warning" :focus-on-mount="false" class="mt-3">
          <p>{{ t('identity.account.closingNotice') }}</p>
        </IdentityAlert>
        <div :class="identityClasses.row" class="mt-4">
          <button v-if="state === 'paused'" type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="act(() => identity.resumeIdentity(), 'identity.account.resumed')">
            {{ t('identity.account.resume') }}
          </button>
          <button v-if="state === 'active' && confirming !== 'pause'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="confirming = 'pause'">
            {{ t('identity.account.pause') }}
          </button>
          <button v-if="state === 'closure-pending'" type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="act(() => identity.cancelClosure(), 'identity.account.closureCancelled')">
            {{ t('identity.account.cancelClosure') }}
          </button>
        </div>
        <div v-if="confirming === 'pause'" :class="identityClasses.stack" class="mt-4">
          <p :class="identityClasses.text">{{ t('identity.account.pauseExplained') }}</p>
          <IdentityAlert v-if="me.lastOwnerOf.length > 0" tone="warning" :focus-on-mount="false">
            <p>{{ t('identity.account.lastOwnerWarning', { count: me.lastOwnerOf.length }) }}</p>
          </IdentityAlert>
          <div :class="identityClasses.row">
            <button type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="act(() => identity.pauseIdentity(), 'identity.account.paused')">
              {{ t('identity.account.confirmPause') }}
            </button>
            <button type="button" :class="identityClasses.secondaryButton" @click="confirming = null">{{ t('identity.common.cancel') }}</button>
          </div>
        </div>
      </section>

      <section :class="identityClasses.section" aria-labelledby="identity-account-groups">
        <h2 id="identity-account-groups" :class="identityClasses.sectionTitle">{{ t('identity.account.groupsTitle') }}</h2>
        <p v-if="memberships.length === 0" :class="identityClasses.muted">{{ t('identity.account.noGroups') }}</p>
        <ul v-else :class="identityClasses.list">
          <li v-for="membership in memberships" :key="membership.membershipId" :class="identityClasses.listItem">
            <div>
              <NuxtLink :to="routes.group(membership.group.groupId)" :class="identityClasses.link">{{ nameOf(membership.group.groupId) }}</NuxtLink>
              <span :class="identityClasses.badge" class="ml-2">{{ t(`identity.status.${membership.effectiveStatus}`) }}</span>
              <span v-if="membership.owner" :class="identityClasses.badge" class="ml-2">{{ t('identity.membership.owner') }}</span>
              <span v-if="membership.kind === 'guest'" :class="identityClasses.badge" class="ml-2">{{ t('identity.membership.guest') }}</span>
            </div>
            <div :class="identityClasses.row">
              <button v-if="membership.state === 'active'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="act(() => identity.pauseMembership(membership.membershipId), 'identity.membership.paused')">
                {{ t('identity.membership.pause') }}
              </button>
              <button v-if="membership.state === 'paused'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="act(() => identity.resumeMembership(membership.membershipId), 'identity.membership.resumed')">
                {{ t('identity.membership.resume') }}
              </button>
              <button v-if="confirming !== `leave:${membership.membershipId}`" type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value" @click="confirming = `leave:${membership.membershipId}`">
                {{ t('identity.membership.leave') }}
              </button>
              <template v-else>
                <button type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value" @click="act(() => identity.leaveGroup(membership.membershipId), 'identity.membership.left')">
                  {{ t('identity.membership.confirmLeave', { group: nameOf(membership.group.groupId) }) }}
                </button>
                <button type="button" :class="identityClasses.secondaryButton" @click="confirming = null">{{ t('identity.common.cancel') }}</button>
              </template>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="state === 'active' || state === 'paused'" :class="identityClasses.section" aria-labelledby="identity-account-close">
        <h2 id="identity-account-close" :class="identityClasses.sectionTitle">{{ t('identity.account.closeTitle') }}</h2>
        <p :class="identityClasses.text">{{ t('identity.account.closeExplained') }}</p>
        <div v-if="confirming === 'close'" :class="identityClasses.stack" class="mt-4">
          <template v-if="me.lastOwnerOf.length > 0">
            <IdentityAlert tone="warning" :focus-on-mount="false">
              <p>{{ t('identity.account.closeLastOwner', { count: me.lastOwnerOf.length }) }}</p>
            </IdentityAlert>
            <label :class="identityClasses.row">
              <input v-model="leaveOrphaned" type="checkbox" :class="identityClasses.checkbox">
              <span :class="identityClasses.text">{{ t('identity.account.leaveOrphaned') }}</span>
            </label>
          </template>
          <div :class="identityClasses.row">
            <button
              type="button"
              :class="identityClasses.dangerButton"
              :disabled="action.disabled.value || (me.lastOwnerOf.length > 0 && !leaveOrphaned)"
              @click="act(() => identity.requestClosure(leaveOrphaned), 'identity.account.closureRequested')"
            >
              {{ t('identity.account.confirmClose') }}
            </button>
            <button type="button" :class="identityClasses.secondaryButton" @click="confirming = null">{{ t('identity.common.cancel') }}</button>
          </div>
        </div>
        <button v-else type="button" :class="identityClasses.dangerButton" class="mt-4" :disabled="action.disabled.value" @click="confirming = 'close'">
          {{ t('identity.account.close') }}
        </button>
      </section>
    </template>
  </div>
</template>
