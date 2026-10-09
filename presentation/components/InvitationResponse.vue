<script setup lang="ts">
/**
 * PUBLIC. Accepting or declining an invitation. The token travels in the
 * link's fragment (`#token`), which browsers never send to a server or in a
 * Referer, and is read here in the browser only. Whatever happens, the
 * answer is the same, so the page cannot be used to test tokens.
 */
const identity = useIdentity()
const routes = useIdentityRoutes()
const { t } = useIdentityText()
const action = useIdentityAction()
const token = ref<string | null>(null)
const done = ref<'accepted' | 'declined' | null>(null)
const signedOut = ref(false)

// Read again when only the fragment changes, as when a second link is opened in the same tab.
function readToken() {
  const value = window.location.hash.slice(1)
  token.value = /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
  if (token.value) done.value = null
}
onMounted(() => {
  readToken()
  window.addEventListener('hashchange', readToken)
})
onBeforeUnmount(() => window.removeEventListener('hashchange', readToken))

async function respond(kind: 'accepted' | 'declined') {
  const result = await action.run(() => (kind === 'accepted' ? identity.acceptInvitation(token.value!) : identity.declineInvitation(token.value!)))
  if (result) {
    done.value = kind
    history.replaceState(null, '', window.location.pathname)
  }
  else if (action.code.value === 'unauthenticated') {
    signedOut.value = true
  }
}
</script>

<template>
  <div :class="identityClasses.stack">
    <IdentitySignedOut v-if="signedOut" />
    <IdentityAlert v-else-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
    <IdentityAlert v-if="done" tone="success" :focus-on-mount="false">
      <p>{{ t(done === 'accepted' ? 'identity.invitation.acceptedNotice' : 'identity.invitation.declinedNotice') }}</p>
      <p class="mt-2"><NuxtLink :to="routes.account()" :class="identityClasses.actionLink">{{ t('identity.invitation.toAccount') }}</NuxtLink></p>
    </IdentityAlert>
    <template v-else-if="token">
      <p :class="identityClasses.text">{{ t('identity.invitation.explained') }}</p>
      <div :class="identityClasses.row">
        <button type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="respond('accepted')">{{ t('identity.invitation.accept') }}</button>
        <button type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="respond('declined')">{{ t('identity.invitation.decline') }}</button>
      </div>
    </template>
    <IdentityAlert v-else tone="info" :focus-on-mount="false">{{ t('identity.invitation.noToken') }}</IdentityAlert>
  </div>
</template>
