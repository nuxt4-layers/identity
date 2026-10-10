/**
 * The deliberate cross-role pairings in identityClasses (docs/contracts.md
 * §20), which a host's theme must keep legible. Kept outside
 * presentation/utils so that Nuxt does not auto-import it into hosts, where
 * Authentication's and Profile's lists of the same name would collide;
 * hosts and tests import it from `./presentation`.
 */
export const DELIBERATE_PAIRINGS = [
  // Secondary text (hints, notes, definition terms) on the card.
  { token: 'pen-muted-default', on: 'fill-base-default' },
  // An invalid field's border.
  { token: 'edge-error-default', on: 'fill-input-default' },
  // The focus indicator around controls on the card.
  { token: 'edge-base-active', on: 'fill-base-default' },
] as const
