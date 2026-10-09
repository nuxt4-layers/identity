import type { IdentityErrorBody } from '../../contracts'
import { isIdentityErrorCode } from '../../contracts'
import { useIdentityText } from './useIdentityText'

/** The contract error a failed request carried, if any. */
export function identityErrorOf(error: unknown): IdentityErrorBody | null {
  const body = (error as { data?: { data?: unknown } } | null)?.data?.data as Partial<IdentityErrorBody> | undefined
  if (body && isIdentityErrorCode(body.code)) return { code: body.code, messageKey: `identity.error.${body.code}`, ...(body.reason ? { reason: body.reason } : {}) }
  return null
}

/**
 * PUBLIC. Shared state for an action on the layer's pages: a pending flag,
 * the error to show and the code behind it. `disabled` is also true until
 * the component has hydrated, so a form never submits natively.
 */
export function useIdentityAction() {
  const { t } = useIdentityText()
  const pending = ref(false)
  const hydrated = ref(false)
  onMounted(() => { hydrated.value = true })
  const disabled = computed(() => pending.value || !hydrated.value)
  const error = ref<string | null>(null)
  const code = ref<IdentityErrorBody['code'] | null>(null)

  /** A message for a contract error: the rule's own wording when there is one, otherwise the code's. */
  function messageFor(body: IdentityErrorBody | null): string {
    if (!body) return t('identity.error.unavailable')
    if (body.reason) {
      const specific = t(`identity.reason.${body.reason}`)
      if (specific !== `identity.reason.${body.reason}`) return specific
    }
    return t(`identity.error.${body.code}`)
  }

  /** Runs an action, tracking pending state; on failure sets `error` and returns null. */
  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    pending.value = true
    error.value = null
    code.value = null
    try {
      return await action()
    }
    catch (failure) {
      const body = identityErrorOf(failure)
      code.value = body?.code ?? 'unavailable'
      error.value = messageFor(body)
      return null
    }
    finally {
      pending.value = false
    }
  }

  return { pending, disabled, error, code, run, messageFor, t }
}
