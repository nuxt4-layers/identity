import { useAppConfig, useRuntimeConfig } from '#imports'
import type { IdentityMessages } from '../messages'
import { resolveMessage } from '../messages'

/**
 * PUBLIC. Localised text for the layer's pages and components. Hosts change
 * wording or add locales in app.config.ts under `identity.messages`, and set
 * the locale with `NUXT_PUBLIC_IDENTITY_LOCALE`.
 */
export function useIdentityText() {
  const locale = useRuntimeConfig().public.identity.locale
  const overrides = (useAppConfig() as { identity?: { messages?: Record<string, IdentityMessages> } }).identity?.messages
  return {
    locale,
    t: (key: string, params?: Record<string, string | number>) => resolveMessage(key, locale, overrides, params),
  }
}
