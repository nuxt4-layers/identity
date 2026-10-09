<script setup lang="ts">
/**
 * PUBLIC. A group's safety periods (contract §21): those in force and those
 * set here, and, in an active group, a form to request a change. The server
 * decides who may request it and whether the values are allowed; this only
 * collects them.
 */
import type { EffectiveSafetyPeriods, SafetyPeriods, SafetyPeriodSetting } from '../../contracts'
import { PLATFORM_ONLY_SAFETY_PERIODS, SAFETY_PERIOD_SETTINGS } from '../../contracts'

const props = defineProps<{
  groupId: string
  periods: { own: SafetyPeriods, effective: EffectiveSafetyPeriods, isPlatformGroup: boolean }
  active: boolean
}>()
const emit = defineEmits<{ requested: [] }>()
const identity = useIdentity()
const { t } = useIdentityText()
const action = useIdentityAction()

const settings = computed(() => SAFETY_PERIOD_SETTINGS.filter(key => props.periods.isPlatformGroup || !PLATFORM_ONLY_SAFETY_PERIODS.includes(key)))
const inDays = (key: SafetyPeriodSetting) => key.endsWith('Days')
const show = (key: SafetyPeriodSetting, value: number) => t(inDays(key) ? 'identity.safety.days' : 'identity.safety.hours', { n: value })

const editing = ref(false)
// A number input's model is a number once typed in, and an empty string when cleared.
const values = ref<Record<string, string | number>>({})
const reasonCode = ref('')
const reference = ref('')

function edit() {
  values.value = Object.fromEntries(settings.value.map(key => [key, props.periods.own[key] === undefined ? '' : String(props.periods.own[key])]))
  editing.value = true
}

async function submit() {
  const safetyPeriods = Object.fromEntries(
    settings.value.filter(key => String(values.value[key] ?? '').trim() !== '').map(key => [key, Number(values.value[key])]),
  )
  const result = await action.run(() => identity.requestChange({
    type: 'group.change-safety-periods',
    target: { groupId: props.groupId, safetyPeriods },
    justification: { reasonCode: reasonCode.value.trim(), reference: reference.value.trim() || null },
  }))
  if (result) {
    editing.value = false
    reasonCode.value = ''
    reference.value = ''
    emit('requested')
  }
}
</script>

<template>
  <section :class="identityClasses.section" aria-labelledby="identity-safety-title">
    <h2 id="identity-safety-title" :class="identityClasses.sectionTitle">{{ t('identity.safety.title') }}</h2>
    <p :class="identityClasses.muted">{{ t('identity.safety.intro') }}</p>
    <dl :class="identityClasses.definitions" class="mt-4">
      <template v-for="key in settings" :key="key">
        <dt :class="identityClasses.term">{{ t(`identity.safety.key.${key}`) }}</dt>
        <dd :class="identityClasses.definition">
          {{ show(key, periods.effective[key]) }}
          <span :class="identityClasses.badge" class="ml-2">
            {{ periods.own[key] === undefined ? t('identity.safety.notHere') : `${t('identity.safety.here')}: ${show(key, periods.own[key]!)}` }}
          </span>
        </dd>
      </template>
    </dl>

    <template v-if="active">
      <IdentityAlert v-if="editing && action.error.value" tone="error">{{ action.error.value }}</IdentityAlert>
      <form v-if="editing" :class="identityClasses.stack" class="mt-4" novalidate @submit.prevent="submit">
        <p :id="`identity-safety-hint-${groupId}`" :class="identityClasses.hint">{{ t('identity.safety.valueHint') }}</p>
        <div v-for="key in settings" :key="key">
          <label :for="`identity-safety-${key}`" :class="identityClasses.label">
            {{ t(`identity.safety.key.${key}`) }} ({{ t(inDays(key) ? 'identity.safety.unitDays' : 'identity.safety.unitHours') }})
          </label>
          <input
            :id="`identity-safety-${key}`"
            v-model="values[key]"
            type="number"
            inputmode="numeric"
            min="1"
            step="1"
            autocomplete="off"
            :class="identityClasses.input"
            :aria-describedby="`identity-safety-hint-${groupId}`"
            :aria-invalid="action.code.value === 'validation-failed' || action.code.value === 'conflict'"
          >
        </div>
        <div>
          <label for="identity-safety-reason" :class="identityClasses.label">{{ t('identity.safety.reasonCode') }}</label>
          <input id="identity-safety-reason" v-model="reasonCode" type="text" maxlength="64" required autocomplete="off" :class="identityClasses.input" aria-describedby="identity-safety-reason-hint">
          <p id="identity-safety-reason-hint" :class="identityClasses.hint">{{ t('identity.safety.reasonHint') }}</p>
        </div>
        <div>
          <label for="identity-safety-reference" :class="identityClasses.label">{{ t('identity.safety.reference') }}</label>
          <input id="identity-safety-reference" v-model="reference" type="text" maxlength="128" autocomplete="off" :class="identityClasses.input" aria-describedby="identity-safety-reference-hint">
          <p id="identity-safety-reference-hint" :class="identityClasses.hint">{{ t('identity.safety.referenceHint') }}</p>
        </div>
        <div :class="identityClasses.row">
          <button type="submit" :class="identityClasses.primaryButton" :disabled="action.disabled.value || !reasonCode.trim()">{{ t('identity.safety.submit') }}</button>
          <button type="button" :class="identityClasses.secondaryButton" @click="editing = false">{{ t('identity.common.cancel') }}</button>
        </div>
      </form>
      <div v-else :class="identityClasses.row" class="mt-4">
        <button type="button" :class="identityClasses.secondaryButton" @click="edit">{{ t('identity.safety.change') }}</button>
      </div>
    </template>
  </section>
</template>
