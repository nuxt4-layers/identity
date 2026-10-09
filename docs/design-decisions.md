# Identity Design Round: Decisions

**Date:** 2026-10-09  
**Inputs:** the questions decided before this round in iam-integration's [roadmap](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/roadmap.md) and [improvement register](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/improvement-register.md) (questions 1 to 4, D1 to D3), and the questions below, decided by the project owner in this round. The amendments these need in iam-integration are listed in §10 and made in [nuxt4-layers/iam-integration#6](https://github.com/nuxt4-layers/iam-integration/pull/6), merged on 2026-10-09; this repository's links are pinned to that merge.

## 1. Better Auth accepts an identifier issued by Identity (roadmap decision 1)

**Question.** Can Authentication's engine, Better Auth, use an identity identifier issued by Identity as its user identifier, or must Authentication keep a private map?

**Verified.** Yes. Better Auth 1.7.7, the version Authentication uses, was tested with a real email sign-up:

| Mechanism | Result |
|---|---|
| `databaseHooks.user.create.before` returning `{ data: { ...user, id } }` | The supplied UUIDv7 became the user's `id` and the account's `userId`. The engine creates hooked records with `forceAllowId: true` |
| `advanced.database.generateId` returning the identifier for the `user` model | Same result |
| Either mechanism throwing (Identity unavailable) | Sign-up failed and no user was created |

The hook is preferred: it may be asynchronous (it calls the provisioning port), and the engine runs it for email sign-up and for federated sign-up alike. **Authentication needs no private map.** Its engine user identifier is the identity identifier.

**Consequence.** The engine creates its user record at sign-up, before the sign-in identifier is verified, so an identifier must exist before verification. iam-integration's provisioning process assumed verification came first. Decided:

**Two-step provisioning with a `pending` identity state.** `reserve` issues a `pending` identity (not in the directory, no access, no events); Authentication stores it against the sign-up attempt in its own schema, so a retry reuses it; `confirm`, after verification, creates the personal group and membership, makes the identity `active` and writes `identity.provisioned`. Identity closes an identity not confirmed within 24 hours and writes `identity.provisioning-expired`, so Authentication can discard the unverified account. This keeps the Group Model's rule that an incomplete identity never becomes active.

Observed in passing: Authentication passes `name: ''` to the engine at email sign-up, so it stores no name. For federated sign-up, the engine fills `name` (and `image`) from the provider's profile by default; Authentication should blank them (a change recorded in the [roadmap](roadmap.md)), since names are Profile's.

## 2. Directory vocabulary

**Decided:** Identity's directory port uses Identity's own vocabulary: `paused` memberships, membership kind and dates, the identity's state, and an effective status Identity computes. The host's adapter maps it to Authorisation's `AuthorisationDirectory`: `paused` becomes `suspended` for contract 2 and passes through for contract 3. Identity's contract does not change when Authorisation's does.

## 3. The personal group's tenant

**Decided:** every identity has a **home tenant**, fixed at provisioning: the inviting tenant for a sign-up through an invitation, otherwise the host's default. The personal group lives there, which settles the jurisdiction and data region of what the person keeps for themselves. Moving it is a later, person-initiated process.

## 4. Invitations to an address

**Decided:** a bearer token, and the address is never stored. Implemented more strictly than proposed: the address never reaches Identity at all. The host's invitation endpoint receives the token from Identity once and hands token and address to its own delivery. Identity stores only the token's SHA-256 digest. An invitation to an existing identity is bound to that identity.

## 5. Membership dates

**Decided:** an effective window evaluated whenever the membership is read, with no new state. A membership before `startsAt` confers nothing and is left out of directory answers; one past `endsAt` is reported ended at once, and a sweeper records it later. Access never waits on a job.

## 6. Departure data policy

**Decided:** besides `attribution` (`keep-name`, `pseudonymise`, `anonymise`), a group setting holds `historyVisibility` (`all-members`, `administrators` by default, `nobody`), `deletionRequests` (`anonymise` by default, `erase-where-lawful`, `review`) and `retentionReasons` (reason codes).

## 7. What a group may say about itself

**Decided:** a safe name only: no description and no group type. Domain capabilities own descriptions and types. This keeps free text, a possible carrier of personal data, to one constrained field.

## 8. Identity's access-decision port and permission names

**Decided:** Identity's contract adds an access-decision port, supplied from Authorisation, which iam-integration's architecture §3 lacked. Identity's permissions follow Authorisation's `<resource>:<action>` grammar (`identity.groups:create`, not `identity.group.create`). iam-integration is corrected in the same round.

## 9. Defaults taken without a question

| Topic | Default |
|---|---|
| Coarse errors | One `forbidden` covers "not found" and "not allowed", matching Authorisation |
| Default and guest roles | Authorisation's; `membership.added` carries the kind |
| A leaver's own anonymisation choice, and pseudonyms | Profile's |
| Disclosure-context port | Batched: one viewer, up to 200 subjects, one group context. "Administrators only" is a question Profile asks Authorisation |
| Break-glass | An identity kind: no personal group; `passkeyOnly` in the sign-in status; three actions; a review closed by another person |
| SCIM `externalId` | Unique per tenant; values with `@` or spaces refused |
| Service identities | Owned by a group |
| Hierarchy depth | 10 by default, at most 32 |
| Identity-state transitions not drawn in the state model | Suspension also from `paused`; reinstatement and closure cancellation restore the previous state; closure may be requested while suspended |
| Conformance suite | Exported as `./conformance`, free of any test framework |
| Group Model Definition | Referenced at a pinned commit; moving it into this repository (ADR-0004 guardrail) is a separate change |

## 10. Amendments proposed to iam-integration

- `docs/states.md`: the `pending` identity state; suspension from `paused`; reinstatement to the previous state; membership dates and effective status.
- `docs/processes/provisioning.md`: two-step provisioning, `identity.provisioning-expired`, the home tenant.
- `docs/processes/joining-and-leaving.md`: invitation tokens and addresses; the departure data policy's fields.
- `docs/architecture.md` §2 to §4: the verified identifier decision; the access-decision port; the new events.
- `docs/processes/*.md`: permission names in Authorisation's grammar.
- `docs/roadmap.md`: decision 1 verified; Identity phase 1 in progress; the changes Authentication needs.

## 11. Decisions after the round

Decided by the project owner on 2026-10-09, after reviewing the questions left open:

| Question | Decision |
|---|---|
| Authentication stores the name and picture a provider supplies at federated sign-up | **Authentication is never a source of profile data, nor of the workflows over it.** It stores no name or picture (the engine's fields stay empty) and blanks any stored before; it never serves or seeds profile attributes. Sign-in identifiers remain Authentication's (ADR-0006 §6). Importing a provider's claims into a profile, if ever wanted, is a Profile workflow in Profile's contract |
| A forwarded invitation link admits someone else | A group setting, `joining.invitationAcceptance`, by membership kind: `immediate` or `confirm`. With `confirm`, an accepted unbound invitation waits for an administrator to confirm who accepted. Default `confirm` for guests, `immediate` for members. Every acceptance notifies the inviter (`invitation.accepted`) |
| A group name could identify a person | Accepted with treatment: names stay out of events, logs and port answers; a valid correction or erasure request about a group name is met by a rename, through iam-integration's data-subject request process; administration pages advise against personal names |

## 12. Phase 2 storage decisions

Decided by the project owner on 2026-10-09, before phase 2:

| Question | Decision |
|---|---|
| Query layer | Hand-written, parameterised SQL over the host's `pg` pool, in append-only migrations. No runtime dependency beyond zod |
| Row-level security for reads that cross tenants | Row-level security on tenant-isolated tables, keyed on the transaction-local `identity.tenant_ids`. Cross-tenant port reads (provisioning, sign-in status, directory, and later disclosure) go only through SECURITY DEFINER functions returning exactly the port's fields; the runtime role has no grant on the cross-tenant tables |
| Background work | Host-scheduled server functions (`runIdentityMaintenance`, `relayIdentityOutbox`), idempotent and safe on several instances; access never depends on them |
| Delivery | Two pull requests: 2a (storage, roles and row-level security, outbox, provisioning, directory) and 2b (groups, hierarchy, memberships, sweeper, disclosure context) |

Found while building 2a: a `pending` person, or one closed without ever being confirmed, has no personal group yet, so the identity schema allows that, and only that.

Taken while building 2b, within those decisions:

- **Writes within one tenant are direct statements under row-level security**, so isolation protects writes as well as reads. The runtime role may insert child groups and memberships and update only the columns 2b changes; guard triggers refuse root groups and any ownership except the founding owner of a group created in the same transaction.
- **Events come from row changes.** SECURITY DEFINER triggers write them to the outbox from the actual change, with the actor and correlation identifier the layer sets for the transaction. The runtime role never writes the outbox, so it cannot forge an event, and a change without a correlation identifier is refused, so none goes unannounced.


## 13. Phase 3 decisions

Decided by the project owner on 2026-10-09, before phase 3:

| Question | Decision |
|---|---|
| Delivery | Three pull requests: 3a, the approvals engine and every gated change (root groups, owners, reparenting, archiving, settings and approval requirements, membership dates and guest renewal, reinstatement, identity suspension, service identities); 3b, invitations with confirmation of who accepted and join requests; 3c, the identity lifecycle (pause, resume, closure with its grace period), orphaned-group recovery, the recovery hold and break-glass actions and reviews |
| Who governs platform-wide changes, and hears objections in recovery | A **platform group** the host designates (`platformGroupId`): a standard group whose owners and qualifying members are the platform's operators |
| How Identity learns of a credential recovery, for the recovery hold | From Authentication's `authentication.credentials-recovered` event, which the host relays to Identity (phase 3c) |
| How a sign-up through an invitation gets its home tenant | The invitation token is passed to `reserve`, which resolves the inviting tenant on the server (phase 3b) |

Taken while building 3a, within those decisions:

- **Bootstrap with the migration role.** A tenant's first root group, and the tenant itself, are created by the operator's procedures with the migration pool (`provisionIdentityTenant`, `bootstrapIdentityRootGroup`). The runtime role can create neither. Every later root group is a `group.create-root` change approved in the platform group, so the platform group's own root is the one group created without an approval, by the operator, once.
- **The database computes the digest** over everything the change will do (target, issued identifier, the state it was requested against, route and requirement) and checks it again before applying. Approvers quote the digest they were shown.
- **Rules are checked twice**: when the change is requested, to give the requester a useful refusal, and when it applies, because days may pass. A change whose rule no longer holds is recorded `rejected`, not left pending.
- **Settings and approval requirements are separate changes**, so that raising or restoring a requirement is always `critical` and a settings change cannot carry one. A settings change applies only if the settings it was requested against are unchanged.
- **The owner fallbacks ask for one owner**, even where the group raised its requirement to two, because the fallback applies only when the group cannot meet its own requirement (threat model §4).
- **Owners are suspended, not removed, by `group.suspend-owner`**, and the last active owner is protected throughout; demotion (`group.remove-owner`) keeps the membership.

Taken while building 3b, within those decisions:

- **Creating an invitation returns its token**, once, to an authorised inviter; only accepting and declining answer the uniform acknowledgement. The contract's earlier wording, which applied the acknowledgement to creation too, could not be met while the inviter must receive the token.
- **No self-admission.** An inviter cannot accept their own unbound invitation, as nobody confirms their own acceptance or decides their own join request: joining is a membership conferred, and the no-self-grant rule applies.
- **Every acceptance or decline is an attempt**, counted against `acceptanceAttemptsPerHour` whether the token is real or not, and recorded outside the transaction's outcome so a failed guess still counts.
- **An unusable token in `reserve` falls back to the default home tenant**, so `reserve` reveals nothing about tokens either; reserving does not use the invitation up.
- **Join requests and open joining are for people already in the tenant**: their home tenant, or a membership in effect there. Groups elsewhere are `forbidden`, like unknown ones.

Taken while building 3c, within those decisions:

- **Orphaning is recorded, not inferred.** Triggers on owners' memberships and identities record a group `orphaned` the moment no owner is in effect, and `active` again when one returns, announcing both. Archiving ends memberships without orphaning.
- **Recovery's authority is Identity's own record of ownership**, not a permission from Authorisation, because the people the process names (owners above, the group's members) are facts Identity holds. A member's proposal is limited to the longest-standing member and to the published delay, which is the only place someone may propose themselves; an objection by any member moves the decision to the platform group.
- **Recovery's published delay is `orphanRecoveryDelayDays`** (14) on every route that falls back to a delay.
- **The recovery hold is enforced in the database**: it marks the change when recorded, announces it (`approval.held`), and holds an approved change as `delayed` until the hold ends.
- **Closure withdraws the person's pending work** at the end of the grace period: their pending changes are cancelled, invitations they sent or accepted revoked, and their join requests withdrawn, so nothing they started can take effect after they are gone.
- **Pausing never asks permission and never fails for being the last owner**; it reports the groups it orphans, as the pausing process requires a warning.

## 14. Phase 4 decisions

Taken while building phase 4, within the decisions above, for the project owner's review:

| Question | Decision |
|---|---|
| Must Authentication, Authorisation and the host change first? | No. Identity's endpoints call its own server functions over the ports the host supplies, and are tested with stand-ins for them. Composing the real members is phase 6, through iam-integration's reference adapters |
| How do endpoints know who is asking, without importing Authentication? | A new port, `IdentitySubjectResolver`, which the host adapts from `getAuthenticatedPrincipal(event)`. The request event passes through opaquely, so the contract still names no HTTP framework |
| An HTTP endpoint for creating invitations? | No. It would put the address through Identity, against §4. The host's own endpoint calls `invite` and hands token and address to its delivery |
| An HTTP endpoint for closing break-glass reviews? | No. Whether the closer held the passkey is the host's attestation, which a browser cannot give |
| SCIM and data-subject exports over HTTP? | No: server functions (`getIdentityScimStructure`, `exportIdentityData`) for the host's composed SCIM endpoint and iam-integration's data-subject process. Members do not call one another over HTTP |
| Error detail | `IdentityErrorBody` gains `reason`, the rule as a code, for `conflict` and `validation-failed` only, so pages can say why without guessing; `forbidden` never carries one |
| CSRF | As Authentication: the `Origin` or `Referer` must match the configured base URL, and without one configured every state-changing request is refused |
| Runtime dependencies | Still zod alone: `h3` is Nuxt's, which the host already has; it is a development dependency here for tests and type-checking |

## 15. Phase 5 decisions

The project owner asked to use Theme Manager's current commit, `934d1bd` (0.2.1 with a documentation change). Taken while building phase 5, for the project owner's review:

| Question | Decision |
|---|---|
| How the pages look and behave | As Authentication's: the same SemanticPresentationTheme rules, Fill, Pen and Edge pairing tests, Theme Manager scales, message catalogue, presentation module options and browser tests, so the suite's pages are alike |
| Who is signed in, without Authentication | The pages call the endpoints, which ask the host's subject resolver. Signed out, they link to the host's sign-in page (`identity.routes.signIn`) with `?redirect=`; they never import Authentication's middleware |
| People's names | Identity has none. `IdentityPersonName` shows a short label from the identifier, and a host overrides the component with one backed by Profile. The person's own view now carries their groups' names, which members may see; names still never enter events or other members' ports |
| Invitation links | The token in the fragment (`/invitations/accept#token`), not the query: browsers do not send fragments to servers or in `Referer`, so it never reaches logs |
| Inviting someone | Still the host's own form (§14): the pages list, confirm, refuse and revoke invitations, but never take an address |
| Runtime dependencies | Still zod alone. The module uses `nuxt/kit` from the host's Nuxt; Theme Manager, Tailwind and Playwright are development dependencies, and Theme Manager is declared an optional capability: without it the pages are unstyled but work |
| Installing Theme Manager | From GitHub at the pinned commit, as Authentication does. This environment cannot reach GitHub's archive host, so the lockfile's entry for it was written in the same form as Authentication's, and CI's frozen install verifies it |
