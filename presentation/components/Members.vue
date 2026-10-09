<script setup lang="ts">
/** PUBLIC. A group's live memberships, a page at a time (`identity.memberships:view`); nothing when refused. */
const props = defineProps<{ groupId: string }>()
const identity = useIdentity()
const { t } = useIdentityText()
const action = useIdentityAction()
const reason = ref('')
const acting = ref<string | null>(null)
const pages = ref<string[]>([])
const after = computed(() => pages.value.at(-1))

const { data: page, error, refresh } = await useAsyncData(`identity-members-${props.groupId}`, () => identity.members(props.groupId, after.value), { watch: [after] })
const refused = computed(() => !!error.value)

async function act(membershipId: string, kind: 'suspend' | 'remove') {
  const result = await action.run<unknown>(() => (kind === 'suspend' ? identity.suspendMember(membershipId, reason.value) : identity.removeMember(membershipId, reason.value)))
  if (result) {
    acting.value = null
    reason.value = ''
    await refresh()
  }
}
</script>

<template>
  <section v-if="!refused && page" :class="identityClasses.section" aria-labelledby="identity-members-title">
    <h2 id="identity-members-title" :class="identityClasses.sectionTitle">{{ t('identity.members.title') }}</h2>
    <IdentityAlert v-if="action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
    <ul :class="identityClasses.list">
      <li v-for="member in page.members" :key="member.membership.membershipId" :class="identityClasses.listItem">
        <div>
          <IdentityPersonName :identity-id="member.membership.identityId" />
          <span :class="identityClasses.badge" class="ml-2">{{ t(`identity.status.${member.effectiveStatus}`) }}</span>
          <span v-if="member.membership.owner" :class="identityClasses.badge" class="ml-2">{{ t('identity.membership.owner') }}</span>
          <span v-if="member.membership.kind === 'guest'" :class="identityClasses.badge" class="ml-2">{{ t('identity.membership.guest') }}</span>
        </div>
        <div v-if="!member.membership.owner" :class="identityClasses.row">
          <form v-if="acting === member.membership.membershipId" :class="identityClasses.row" novalidate @submit.prevent>
            <label :for="`identity-reason-${member.membership.membershipId}`" :class="identityClasses.label">{{ t('identity.members.reasonCode') }}</label>
            <input :id="`identity-reason-${member.membership.membershipId}`" v-model="reason" type="text" maxlength="64" autocomplete="off" :class="identityClasses.input" :aria-describedby="`identity-reason-hint-${member.membership.membershipId}`">
            <p :id="`identity-reason-hint-${member.membership.membershipId}`" :class="identityClasses.hint">{{ t('identity.members.reasonHint') }}</p>
            <button type="button" :class="identityClasses.secondaryButton" :disabled="action.disabled.value || !reason" @click="act(member.membership.membershipId, 'suspend')">{{ t('identity.members.suspend') }}</button>
            <button type="button" :class="identityClasses.dangerButton" :disabled="action.disabled.value || !reason" @click="act(member.membership.membershipId, 'remove')">{{ t('identity.members.remove') }}</button>
            <button type="button" :class="identityClasses.secondaryButton" @click="acting = null">{{ t('identity.common.cancel') }}</button>
          </form>
          <button v-else type="button" :class="identityClasses.secondaryButton" @click="acting = member.membership.membershipId">{{ t('identity.members.manage') }}</button>
        </div>
      </li>
    </ul>
    <div :class="identityClasses.row" class="mt-3">
      <button v-if="pages.length > 0" type="button" :class="identityClasses.secondaryButton" @click="pages.pop()">{{ t('identity.common.previous') }}</button>
      <button v-if="page.nextCursor" type="button" :class="identityClasses.secondaryButton" @click="pages.push(page.nextCursor!)">{{ t('identity.common.next') }}</button>
    </div>
  </section>
</template>
