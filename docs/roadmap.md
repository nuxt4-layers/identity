# Roadmap

Each phase is delivered as its own pull request with tests, and keeps `pnpm check` and the Markdown check green.

| Phase | Scope | Status |
|---|---|---|
| 0. Design round | Decisions on provisioning, directory vocabulary, home tenants, invitations, dates, departure data policy, group text and ports ([design decisions](design-decisions.md)); Better Auth verified to accept Identity's identifier | Complete |
| 1. Foundation | Package, manifest, public contract (zod only): identifiers, safe names, identities and states (with `pending`), tenancy module, groups and settings (reserved pause setting, departure data policy, approval requirements), memberships (kinds, dates, effective status), invitations, permissions, governance approvals, break-glass, provided ports (provisioning, directory, disclosure context), consumed ports, events, errors, policy, SCIM structure; directory conformance suite; composition registry (fail closed); docs, threat model, CI, playground | In review |
| 2a. Core: storage and provisioning | PostgreSQL schema and migrations (hand-written SQL); migration and runtime roles with row-level security and narrow SECURITY DEFINER functions for cross-tenant reads; transactional outbox and relay; provisioning (reserve, confirm, expiry); tenant provisioning for the operator; sign-in status and directory ports, with Identity's directory passing its own conformance suite; host-scheduled maintenance; database tests in CI | In review |
| 2b. Core: groups and memberships | Groups and the hierarchy (cycle, tenant, depth and confusable-sibling checks), membership changes and the dates sweeper, the disclosure-context port, isolation tests across every table | Planned |
| 3. Governance | Pending changes and approvals (routes, published delays, expiry, digests, strong re-checks), invitations (hashing, rate limits, confirmation of who accepted), join requests, orphaned-group recovery, recovery hold, break-glass actions and reviews | Planned |
| 4. Administration | `/api/identity/*` endpoints for groups, memberships, invitations, settings and approvals, each guarded through the access-decision port and step-up, with coarse errors; client composable for user-experience hints only; SCIM structure endpoint for iam-integration to compose | Planned |
| 5. Default pages | Accessible (WCAG 2.2 AA), localisable group, membership, invitation and approval pages through the `SemanticPresentationTheme` vocabulary; can be disabled | Planned |
| 6. Host integration | Composition into `platform-test-harness` with Authentication and Authorisation through iam-integration's reference adapters; end-to-end tests of the iam-integration processes | Planned |

## Improvement register items in phase 1

| # | Item | Where |
|---|---|---|
| 1 | Conformance suite for the directory port | `conformance/index.ts`; [contract](contracts.md) §14 |
| 5 | SCIM-compatible structure: `externalId` on identities (per tenant), groups and tenants; `active` derived from state | `shared/scim.ts`; contract §16 |
| 6 | Safe names | `shared/safe-names.ts`; contract §5.4 |
| 12 | Coarse errors | `shared/errors.ts`; contract §12 |
| 13 | Correlation identifiers on port calls, pending changes and events | `shared/identifiers.ts`, `shared/events.ts`; contract §11 |
| 20 | Invitations: single use, 14-day expiry, non-enumerating, consent, hashed tokens, rate limits | `shared/invitation.ts`; contract §7 |
| 22 | Membership start and end dates | `shared/membership.ts`; contract §6 |

Also in phase 1: the tenancy seam (contract §4), guest memberships (§6), the reserved group pause setting (§5.5), Identity's part of ADR-0007 (§13), and governance approvals with no self-grant, beneficiary and justification, and personal-group sovereignty with step-up (§8).

## Profile's dependencies on Identity

Profile is designed after Identity ([profile README](https://github.com/nuxt4-layers/profile/blob/de43c33f8ac8f8095a1d01c594e822c1b4f0aee2/README.md)). It depends on these parts of Identity's contract, which phase 1 defines:

| Profile needs | Identity provides | Contract |
|---|---|---|
| A record key that refers to nobody once unlinked | The identity identifier (UUIDv7), never derived from personal data | §2, §3 |
| To create, hide, show and anonymise records | Events in `PROFILE_CONSUMED_EVENT_TYPES`: `identity.provisioned`, `.paused`, `.resumed`, `.suspended`, `.reinstated`, `.closure-requested`, `.closure-cancelled`, `.closed`; `membership.added`, `.paused`, `.resumed`, `.suspended`, `.reinstated`, `.ended`; `group.settings-changed` | §11 |
| The viewer's relationship to a subject, the subject's standing, and the group's departure data policy | The disclosure-context port (`IdentityDisclosureContextPort`), batched, `bounded`, failing closed | §10.3 |
| The departure data policy as a group setting | `attribution`, `historyVisibility`, `deletionRequests`, `retentionReasons` | §5.6 |
| Assurance that personal data stays in Profile | The personal-data contract test over every Identity schema | §2 |
| The home tenant's jurisdiction and data region, to place a person's record | `identity.provisioned` carries `homeTenantId`; `tenantSchema` carries jurisdiction and data region | §4 |
| Data-subject request coordination: Identity's part of an export | Identity state, memberships and their history (phase 2 export function) | Phase 2 |

Profile owns, and Identity does not hold: the leaver's own anonymisation choice, pseudonyms for `pseudonymise`, display names, fine-grained pause visibility, and legal holds. Profile asks Authorisation, not Identity, whether a viewer is an administrator. A change to any row above is a breaking change for Profile and is listed in the contract's versioning section.

## Changes required in other members

| Member | Change | Source |
|---|---|---|
| Authentication | Call `reserve` from the engine's `user.create.before` hook and use the returned identifier as the user `id`; store the pending identifier against the sign-up attempt so a retry reuses it; call `confirm` after verification (immediately for provider-verified federated sign-up); discard the account on `identity.provisioning-expired` | [Design decisions](design-decisions.md) §1 |
| Authentication | Refuse sign-in and session refresh according to `signInStatus`; enforce passkey-only sign-in when `passkeyOnly` | Contract §10.1, §13 |
| Authentication | Store no provider-supplied `name` or `image` on federated sign-up, and blank those stored before; Authentication is never a source of profile data. Done in [nuxt4-layers/authentication#18](https://github.com/nuxt4-layers/authentication/pull/18) | Design decisions §1, §11 |
| Authorisation | Accept Identity's permissions in its catalogue; provide the adapters behind `IdentityAccessDecision` and `IdentityApprovalPolicy` (risk, qualification, counting qualifying principals) | Contract §10.4 |
| Authorisation | Apply the group's default role or guest role on `membership.added`, by kind; assign and remove `owner` on `group.created` and `group.owners-changed` | Contract §5.3, §5.5 |
| iam-integration | Done: the amendments in design decisions §10, merged in [nuxt4-layers/iam-integration#6](https://github.com/nuxt4-layers/iam-integration/pull/6). Still to come: reference adapters for the three provided ports, including the `paused` → `suspended` mapping for Authorisation contract 2 | Design decisions §10 |
| platform-architecture | Move the Group Model Definition into this repository, leaving a pointer (ADR-0004 guardrail); list Identity's repository in the catalogue | ADR-0004 |
