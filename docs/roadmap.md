# Roadmap

Each phase is delivered as its own pull request with tests, and keeps `pnpm check` and the Markdown check green.

| Phase | Scope | Status |
|---|---|---|
| 0. Design round | Decisions on provisioning, directory vocabulary, home tenants, invitations, dates, departure data policy, group text and ports ([design decisions](design-decisions.md)); Better Auth verified to accept Identity's identifier | Complete |
| 1. Foundation | Package, manifest, public contract (zod only): identifiers, safe names, identities and states (with `pending`), tenancy module, groups and settings (reserved pause setting, departure data policy, approval requirements), memberships (kinds, dates, effective status), invitations, permissions, governance approvals, break-glass, provided ports (provisioning, directory, disclosure context), consumed ports, events, errors, policy, SCIM structure; directory conformance suite; composition registry (fail closed); docs, threat model, CI, playground | Complete |
| 2a. Core: storage and provisioning | PostgreSQL schema and migrations (hand-written SQL); migration and runtime roles with row-level security and narrow SECURITY DEFINER functions for cross-tenant reads; transactional outbox and relay; provisioning (reserve, confirm, expiry); tenant provisioning for the operator; sign-in status and directory ports, with Identity's directory passing its own conformance suite; host-scheduled maintenance; database tests in CI | Complete |
| 2b. Core: groups and memberships | Child groups and renaming (tenant, cycle, depth and confusable-sibling checks, enforced in the database too); the member's own pause, resume and leave; removal and suspension of members who are not owners; the dates sweeper; the disclosure-context port; events from row-change triggers; the runtime role's writes limited by column grants and guard triggers; isolation tests for writes | Complete |
| 3a. Governance: approvals | The approvals engine (requests, routes with owner fallbacks and published delays, expiry, digests computed by the database, strong re-checks of approvers, step-up by risk, every rule checked again on applying) and every gated change: root groups in the host's platform group, owners, reparenting, archiving, settings and approval requirements, membership dates and guest renewal, reinstatement, identity suspension and reinstatement, service identities; operator bootstrap with the migration role | Complete |
| 3b. Governance: joining | Invitations (tokens generated on the server, hashed, single use, rate-limited, answered alike; confirmation of who accepted; no self-admission; the token passed to `reserve` for the home tenant), join requests and open joining within the tenant, expiry in maintenance | Complete |
| 3c. Governance: lifecycle and recovery | The identity lifecycle (pause and closure after reauthentication, cancellation, closure at the end of the grace period withdrawing the person's pending work), orphaning recorded and undone as owners change, orphaned-group recovery (owners above, or the longest-standing member after a published delay; objections to the platform group), the recovery hold fed by Authentication's `authentication.credentials-recovered`, break-glass provisioning, actions and reviews | Complete |
| 4. Administration | `/api/identity/*` endpoints for the person's own view and lifecycle, groups, members, memberships, invitations (except creation, which stays with the host), join requests, governance changes and break-glass actions, each taking the subject only from the host's resolver, deciding through the same server functions, ports and step-up, with coarse errors and an origin check; `useIdentity()` for the user experience only; read functions; Identity's part of a data-subject export and the SCIM structure as server functions for iam-integration to compose | Complete |
| 5. Default pages | Accessible (WCAG 2.2 AA), localisable account, group, invitation and change pages and `Identity*` components through Theme Manager's `SemanticPresentationTheme` vocabulary (pinned to Theme Manager 0.2.1, commit `934d1bd`); movable or disabled; framing, caching and referrer headers; invitation tokens in the fragment; browser tests with axe in CI | Complete |
| 5a. Safety periods | Configurable published delays, approval expiry, recovery delay, recovery hold and closure grace period: platform, root group and group levels as `critical` governance changes, a less safe value waiting out the old one, checked in the database; shown and requested on the group page ([contract](contracts.md) §21) | In review |
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
| Data-subject request coordination: Identity's part of an export | Identity state, memberships and their history | `exportIdentityData` (phase 4) |

Profile owns, and Identity does not hold: the leaver's own anonymisation choice, pseudonyms for `pseudonymise`, display names, fine-grained pause visibility, and legal holds. Profile asks Authorisation, not Identity, whether a viewer is an administrator. A change to any row above is a breaking change for Profile and is listed in the contract's versioning section.

## Changes required in other members

| Member | Change | Source |
|---|---|---|
| Authentication | Call `reserve` from the engine's `user.create.before` hook and use the returned identifier as the user `id`; store the pending identifier against the sign-up attempt so a retry reuses it; call `confirm` after verification (immediately for provider-verified federated sign-up); discard the account on `identity.provisioning-expired` | [Design decisions](design-decisions.md) §1 |
| Authentication | Refuse sign-in and session refresh according to `signInStatus`; enforce passkey-only sign-in when `passkeyOnly` | Contract §10.1, §13 |
| Host (through iam-integration's reference adapters) | Supply `IdentitySubjectResolver` from Authentication's `getAuthenticatedPrincipal(event)`; set `NUXT_IDENTITY_BASE_URL`; build the invitation endpoint that calls `invite` and hands token and address to delivery | Contract §19 |
| Authentication | When someone signs up through an invitation link, pass its token to `reserve` (`invitationToken`) so the inviting tenant becomes the home tenant; never store or log the token | Contract §7, §10.1 |
| Authentication | Store no provider-supplied `name` or `image` on federated sign-up, and blank those stored before; Authentication is never a source of profile data. Done in [nuxt4-layers/authentication#18](https://github.com/nuxt4-layers/authentication/pull/18) | Design decisions §1, §11 |
| Authorisation | Accept Identity's permissions in its catalogue; provide the adapters behind `IdentityAccessDecision` and `IdentityApprovalPolicy` (risk, qualification, counting qualifying principals) | Contract §10.4 |
| Authentication | Publish `authentication.credentials-recovered` (identity identifier, time and correlation identifier only) after a credential recovery; the host relays it to `recordIdentityCredentialRecovery` for Identity's recovery hold | Design decisions §13; contract §8 |
| Authentication | Enrol and rotate the offline passkey of break-glass identities the operator provisions (`provisionIdentityBreakGlass`); revoke sessions on `identity.paused` (others) and `identity.closure-requested` (all) | Contract §13; iam-integration pausing and closure |
| Authorisation | Apply the group's default role or guest role on `membership.added`, by kind; assign and remove `owner` on `group.created` and `group.owners-changed` | Contract §5.3, §5.5 |
| iam-integration | Done: the amendments in design decisions §10, merged in [nuxt4-layers/iam-integration#6](https://github.com/nuxt4-layers/iam-integration/pull/6). Still to come: reference adapters for the three provided ports, including the `paused` → `suspended` mapping for Authorisation contract 2 | Design decisions §10 |
| platform-architecture | Move the Group Model Definition into this repository, leaving a pointer (ADR-0004 guardrail); list Identity's repository in the catalogue | ADR-0004 |
