<script setup lang="ts">
/**
 * PUBLIC. A group's invitations (`identity.invitations:manage`): revoke open
 * ones, and confirm or refuse whoever accepted one that needs confirmation.
 * Inviting someone is the host's own form, since only the host may see the
 * address an invitation is sent to.
 */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const { t } = useIdentityText()
const action = useIdentityAction()
const { data: invitations, error, refresh } = await useAsyncData(`identity-invitations-${props.groupId}`, () => identity.invitations(props.groupId))

async function act(run: () => Promise<unknown>) {
  // A confirmed acceptance adds a member, so the members section is refreshed too.
  if (await action.run(run)) await Promise.all([refresh(), refreshNuxtData(`identity-members-${props.groupId}`)])
}
</script>

<template>
  <section v-if="!error && invitations && invitations.length > 0" :class="identityClasses.section" aria-labelledby="identity-invitations-title">
    <h2 id="identity-invitations-title" :class="identityClasses.sectionTitle">{{ t('identity.invitations.title') }}</h2>
    <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
    <ul :class="identityClasses.list">
      <li v-for="invitation in invitations" :key="invitation.invitationId" :class="identityClasses.listItem">
        <div>
          <span :class="identityClasses.text">{{ t(`identity.membership.kind.${invitation.kind}`) }}</span>
          <span :class="identityClasses.badge" class="ml-2">{{ t(`identity.invitationState.${invitation.state}`) }}</span>
          <p v-if="invitation.acceptedBy" :class="identityClasses.muted">
            {{ t('identity.invitations.acceptedBy') }} <IdentityPersonName :identity-id="invitation.acceptedBy" />
          </p>
        </div>
        <div :class="identityClasses.row">
          <template v-if="invitation.state === 'awaiting-confirmation'">
            <button type="button" :class="identityClasses.primaryButton" :disabled="action.disabled.value" @click="act(() => identity.decideAcceptance(invitation.invitationId, 'confirm'))">{{ t('identity.invitations.confirm') }}</button>
            <button type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value" @click="act(() => identity.decideAcceptance(invitation.invitationId, 'refuse'))">{{ t('identity.invitations.refuse') }}</button>
          </template>
          <button v-if="invitation.state === 'open' || invitation.state === 'awaiting-confirmation'" type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value" @click="act(() => identity.revokeInvitation(invitation.invitationId))">
            {{ t('identity.invitations.revoke') }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
