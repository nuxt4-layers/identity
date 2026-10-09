# Identity Design Round: Decisions

**Date:** 2026-10-09  
**Inputs:** the questions already decided in iam-integration's [roadmap](https://github.com/nuxt4-layers/iam-integration/blob/19df31458bab5a5190ab6590e58ef01ceabf9533/docs/roadmap.md) and [improvement register](https://github.com/nuxt4-layers/iam-integration/blob/19df31458bab5a5190ab6590e58ef01ceabf9533/docs/improvement-register.md) (questions 1 to 4, D1 to D3), and the questions below, decided by the project owner in this round. The amendments these need in iam-integration are listed in §10 and proposed in [nuxt4-layers/iam-integration#6](https://github.com/nuxt4-layers/iam-integration/pull/6); once merged, this repository's links move to the merged commit.

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
