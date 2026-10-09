# Identity Contract (version 1)

`@nuxt4-layers/identity/contracts` is the only supported import path for this capability's types, schemas and pure helpers. It imports nothing but `zod`: no driver, framework or other capability's package. `@nuxt4-layers/identity/conformance` exports the directory conformance suite, which imports only the contract.

Identity answers one question: **which identity is this, and what is it a member of, in which state?**

Governing documents: the [Group Model Definition v0.1](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/identity/group-model-definition-v01.md), [ADR-0005](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0005-iam-suite.md), and iam-integration's [state models](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/states.md) and [processes](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/processes/README.md). The design round's decisions, including amendments to those documents, are recorded in [design-decisions.md](design-decisions.md).

## 1. Boundaries

| Concern | Owner | How Identity sees it |
|---|---|---|
| Identities, personal groups, groups, the hierarchy, tenants, memberships, their states, group governance settings, pending governance changes | **Identity** | Its own schema (phase 2) |
| Names, contact details, preferences; the leaver's own anonymisation choice; pseudonyms | Profile | Nothing. Profile reads Identity's disclosure-context port and events |
| Credentials, sign-in identifiers, sessions, step-up | Authentication | The subject of each request (`IdentitySubject`), passed in by the host; the provisioning port Authentication calls |
| Roles, assignments, grants, decisions; a group's default and guest roles | Authorisation | The access-decision and approval-policy ports |
| Organisation, club, committee and other domain records | Domain capabilities | Nothing. They reference group identifiers |

Identity holds **no personal data** (§2). It makes **no access decisions**: it asks Authorisation (§10).

## 2. What Identity may hold

Every value Identity stores, publishes or returns is one of:

- an **identifier**: a lower-case UUIDv7 it issued, or a host's correlation UUID;
- a **code**: a state, kind, reason code, jurisdiction or data region, from a fixed set or matching `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`;
- an **instant** (ISO 8601, UTC), a **number** (a version or a count) or a **boolean**;
- a **digest** (SHA-256, for invitation tokens and approved changes);
- an opaque **external identifier** (SCIM `externalId`; `@` and spaces refused) or **justification reference** (`CHG-1042`);
- a group's **safe name** (§5.4).

Every record, event and port-answer schema is a strict object (unknown fields are refused) and is listed in `IDENTITY_DATA_SCHEMAS`. `tests/personal-data.test.ts` walks all of them and proves that no field is named for personal data and that no string is unconstrained, except a group's name. A schema that crosses Identity's boundary and is missing from that list fails review.

A group name is organisational, not personal, data. A group could still be named after a person ("Alice's book club"); this residual risk is recorded in the [threat model](threat-model.md) (T19).

## 3. Identities

| Kind | Personal group | Notes |
|---|---|---|
| `person` | Exactly one, created atomically on confirmation | The usual case |
| `service` | None | Owned by a group (`ownerGroupId`); credentials from Authentication's service-credential flow when one exists |
| `break-glass` | None | ADR-0007: no standing privileges, passkey only, two actions (§13) |

| State | Meaning |
|---|---|
| `pending` | Issued at sign-up, before Authentication has verified the sign-in identifier. Not in the directory, no access, no events. Closed if not confirmed within `pendingConfirmationHours` (24) |
| `active`, `paused`, `suspended`, `closure-pending`, `closed` | As in iam-integration's state models §1 |

Permitted transitions are listed in `IDENTITY_TRANSITIONS`; anything else is refused:

| Action | From | To | By |
|---|---|---|---|
| `confirm` | `pending` | `active` | system, on Authentication's confirmation |
| `expire` | `pending` | `closed` | system |
| `pause` / `resume` | `active` / `paused` | `paused` / `active` | the person only |
| `suspend` | `active`, `paused` | `suspended` | an administrator with approval at `high` risk, or a break-glass account |
| `reinstate` | `suspended` | the previous state | an administrator with approval |
| `request-closure` | `active`, `paused`, `suspended` | `closure-pending` | the person only, after reauthentication |
| `cancel-closure` | `closure-pending` | the previous state | the person only |
| `close` | `closure-pending` | `closed` | system, at the end of the grace period |

`previousState` holds one level. A person who was paused, then suspended, then asked for closure and cancelled it returns to `suspended`; reinstatement then restores `active`.

An identity can be suspended only for platform-wide reasons (abuse, legal order, security incident), with a reason code. A `closed` identity is never reopened and its identifier is never reissued.

## 4. Tenants

A tenant is an isolation boundary, not a group. It is a separate module (`shared/tenant.ts`) that imports nothing else of Identity's, so that it can move to a tenancy capability later without changing what other members see.

| Field | Meaning |
|---|---|
| `jurisdiction` | Selects the tenant's policy pack (UK GDPR, EU GDPR, CCPA). A code the host registers in the policy |
| `dataRegion` | Where the tenant's data is stored, including derived copies and backups (ADR-0006 §7). Set once; changing it is a migration process |
| `state` | `active`, `closing` (no new groups or memberships) or `closed` |

Tenants are provisioned by the platform operator under a written procedure (iam-integration's planned "Tenant lifecycle" process), with `identity.tenants:manage` at `critical` risk.

Every identity has a **home tenant**: the inviting tenant for a sign-up through an invitation, otherwise the policy's `defaultHomeTenantId`, always resolved on the server. The person's personal group lives there, so its jurisdiction and data region govern what the person keeps for themselves. Identities themselves are global: membership of groups in other tenants needs no special kind.

## 5. Groups

### 5.1 Kinds and states

A `personal` group has one permanent member, no parent, no name and no settings, and is always `active`; it follows its identity. A `standard` group has a safe name and settings, and is `active`, `orphaned` (no active owner; governed only through recovery) or `archived` (read-only).

### 5.2 Hierarchy

Each standard group has zero or one parent **in the same tenant**. Reparenting refuses cycles (`wouldCreateCycle`) and moves across tenants, and is `critical`. Lineage is the chain from the root to the group, at most `maxHierarchyDepth` (10) long. The hierarchy confers nothing: a member of a parent is not a member of its children.

### 5.3 Owners

Ownership is recorded on the membership (`owner`); Authorisation holds the matching `owner` role, assigned in response to `group.created` and `group.owners-changed`. The creator is the founding owner (`foundingOwner`), which is provenance only. A group always has at least one active owner: pausing, suspending, removing or demoting the last one is refused (`refusedByGovernance`), except through recovery or account closure. A guest cannot be an owner.

### 5.4 Safe names

`checkSafeName` (improvement register item 6) normalises to NFC, trims and collapses spaces, and refuses control, format (zero-width, bidirectional), private-use, unassigned and surrogate code points, line and paragraph separators, names over 100 code points, and mixed scripts beyond UTS #39's "highly restrictive" combinations. `confusableSkeleton` maps whole-script look-alikes to one skeleton, so the server can refuse a name confusable with a sibling's (phase 2). Problems are returned as codes for localisation.

### 5.5 Settings

| Setting | Values | Default |
|---|---|---|
| `joining.requests` | Members may ask to join; an administrator decides | `true` |
| `joining.open` | Anyone in the tenant may join without approval | `false` |
| `joining.invitationAcceptance` | By kind, whether accepting an unbound invitation creates the membership at once (`immediate`) or waits for an administrator to confirm who accepted (`confirm`) | `member` immediate, `guest` confirm |
| `pausing` | **Reserved** with the single value `allowed`. A later contract MAY add `notice` and `approval`; none can prevent an account-wide pause | `allowed` |
| `guests.allowed`, `guests.termDays` | Whether guests may join, and their term before renewal (at most the policy's `guestTermDays`) | `true`, 90 |
| `approvals.required` | Approvers needed beyond the requester, by risk. May be raised, never lowered below the floor (§8) | `low` 0, `medium` 0, `high` 1, `critical` 1 |
| `approvals.referenceRequired` | Whether a governance change needs a justification reference as well as a reason code | `false` |
| `onArchive` | `end-memberships` or `read-only` | `read-only` |
| `departure` | The departure data policy (§5.6) | See below |

The group's default role and guest role are Authorisation's, not settings here: Authorisation applies them in response to `membership.added`, which carries the membership kind.

### 5.6 Departure data policy

What happens to a leaver's attribution in the group's information (ADR-0005 §2.7). Profile applies it; Identity stores it and supplies it through the disclosure-context port.

| Field | Values | Default |
|---|---|---|
| `attribution` | `keep-name`, `pseudonymise`, `anonymise` | `keep-name` |
| `historyVisibility` | Whether the leaver appears in the member history, and to whom: `all-members`, `administrators`, `nobody` | `administrators` |
| `deletionRequests` | When the leaver asks for deletion: `anonymise` (unlink attribution, the floor), `erase-where-lawful` (domain capabilities erase the leaver's contributions unless a retention reason applies), `review` (an administrator decides within the jurisdiction's deadline) | `anonymise` |
| `retentionReasons` | Why the group must keep information, as reason codes (at most 16) | none |

The leaver may always choose anonymisation for themselves, whatever the policy, within the law. That choice is personal and is recorded by Profile.

## 6. Memberships

| Kind | Meaning |
|---|---|
| `member` | An ordinary member |
| `guest` | An outside collaborator: Authorisation applies the group's restricted guest role; an end date is required (90 days after joining by default), renewable by an administrator |

States are `active`, `paused`, `suspended` and `ended` (final; rejoining creates a new membership). An ended membership records `endedAt` and `endReason` (`left`, `removed`, `expired`, `identity-closed`, `group-archived`), and a removal or suspension records a reason code.

**Dates** (improvement register item 22). `startsAt` and `endsAt` define the window in which a membership can confer anything. There is no separate state for scheduled memberships: the window is evaluated whenever the membership is read, so access never waits for a scheduled job. A sweeper later records lapsed memberships as `ended` (`expired`) and writes `membership.ended`.

**Effective status** combines a membership's state, its dates and its identity's state (`effectiveStatus`). The most restrictive applies:

| Effective status | When |
|---|---|
| `ended` | Recorded `ended`, past `endsAt`, or the identity is `closed` |
| `not-started` | Before `startsAt`. Left out of directory answers |
| `suspended` | Its own state, or the identity is `suspended`, `closure-pending` or `pending` |
| `paused` | Its own state, or the identity is `paused` (state models §2 rule 2) |
| `active` | Otherwise |

A personal group's membership is never paused, suspended or ended on its own; it follows the identity. Leaving or pausing it is refused.

## 7. Invitations

An invitation is a single-use bearer token (improvement register item 20):

- **Identity never sees the address.** The host's invitation endpoint asks Identity for an invitation, receives the token once, and passes token and address to its own delivery. Identity stores only the token's SHA-256 digest.
- The token is 256 random bits, delivered as 43 base64url characters, and expires after `invitationExpiryDays` (14).
- An invitation to an existing identity is bound to it (`inviteeIdentityId`); only that identity may accept. Otherwise any signed-in identity holding the token may accept, being provisioned first if new, with its home tenant set to the inviting tenant.
- Nobody joins without their own consent, except a service identity added by an administrator.
- **Confirmation of forwarded links.** Where the group's `joining.invitationAcceptance` for the invitation's kind is `confirm` (guests, by default), an unbound invitation that is accepted waits in `awaiting-confirmation`. An administrator with `identity.invitations:manage` sees who accepted (through Profile's display name) and confirms, which creates the membership, or refuses. Nobody confirms their own acceptance (`refuseConfirmation`); the inviter may. The setting is fixed on the invitation when it is created (`requiresConfirmation`). A confirmation not given within `approvalExpiryDays` (7) expires the invitation.
- Every acceptance writes `invitation.accepted`, so the inviter is told who joined (or is waiting) whatever the setting; a refusal writes `invitation.refused`.
- Creation and acceptance answer `INVITATION_ACKNOWLEDGEMENT` whenever the request is well formed, whatever happened, so they cannot be used to probe for groups, identities or tokens.
- Rate limits: `invitationsPerInviterPerHour` (50), `invitationsPerGroupPerDay` (200), `acceptanceAttemptsPerHour` (20).
- An invitation may carry `membershipStartsAt` and `membershipEndsAt` for scheduled joiners and leavers.

## 8. Governance approvals

Identity owns pending **governance** changes; Authorisation owns pending role and grant changes. Both follow iam-integration's [approvals process](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/processes/approvals.md).

**Changes Identity records** (`GOVERNANCE_CHANGES`): create a root group, reparent, archive, change settings, change approval requirements, add, remove or suspend an owner, appoint an owner to an orphaned group, reinstate or reschedule a membership, suspend or reinstate an identity, and create a service identity. Each names the permission it exercises (§9) and whether it **confers** something on its beneficiary.

**A pending change records** its requester, **beneficiary**, risk, **justification** (a reason code, and a reference where the group requires one), the approvals required, the route, the approvals given (approver, decision, time, assurance and the digest they approved), a digest of the exact change, the expiry or delay, and the correlation identifier.

**Rules:**

1. **No self-grant at any risk level** (`refuseRequest` → `self-grant`). Outside their own personal group, nobody requests a change that confers ownership, a reinstatement, an appointment or new membership dates on themselves.
2. **Approvers** (`refuseApproval`) are never the requester, never the beneficiary, never an identity the requester controls (such as a service identity they created), and must still qualify at decision time: Identity asks Authorisation with a `strong` read when the approval is given. Each approver decides once.
3. **Exact change.** An approval is bound to the change's digest; a change that differs needs a new approval.
4. **Assurance.** Requesters and approvers meet `STEP_UP_REQUIREMENTS` for the risk: `high` needs aal2; `critical` needs phishing-resistant aal2 within the last 15 minutes.
5. **Requirement.** `approvalRequirement` takes the group's setting, never below the floor (`low` and `medium`: 0 beyond a requester who is never the beneficiary; `high` and `critical`: 1). Raising it is `critical`.
6. **Routes** (`chooseRoute`): qualifying approvers in the group; otherwise an owner of the parent group; otherwise an owner of the tenant's root group; otherwise a **published delay** of `publishedDelayHighHours` (72) or `publishedDelayCriticalHours` (168) that the requester cannot shorten and may cancel. A change awaiting an approver expires after `approvalExpiryDays` (7).
7. **Personal-group sovereignty.** In their own personal group a person needs **no approver**, including to share what it owns with others (sharing itself is an Authorisation grant, under the same rule), but must still **step up** to the risk level's assurance, which protects them if a session is stolen.
8. **Recovery hold.** After credential recovery, `critical` governance changes the recovered person requests are held for `recoveryHoldHours` (72) and announced to their groups' co-owners.

## 9. Permissions

Identity's permissions follow Authorisation's grammar (`<resource>:<action>`). The host adds `IDENTITY_PERMISSIONS` to Authorisation's catalogue.

| Permission | Risk |
|---|---|
| `identity.groups:view`, `identity.memberships:view`, `identity.tenants:view` | low |
| `identity.groups:create` (child group), `identity.groups:rename`, `identity.invitations:manage`, `identity.join-requests:decide`, `identity.memberships:remove`, `identity.memberships:suspend`, `identity.memberships:schedule` | medium |
| `identity.root-groups:create`, `identity.groups:archive`, `identity.group-settings:manage`, `identity.service-identities:create`, `identity.service-identities:manage`, `identity.identities:suspend`, `identity.break-glass-reviews:close` | high |
| `identity.groups:reparent`, `identity.group-approvals:manage`, `identity.group-owners:manage`, `identity.orphaned-groups:recover`, `identity.tenants:manage` | critical |

Removing or suspending an ordinary member is `medium`; doing so to an owner is `identity.group-owners:manage`, `critical`. Acting on oneself (pausing, resuming, leaving, accepting an invitation, requesting or cancelling closure) needs no permission and is never delegated.

## 10. Ports

### 10.1 Provided: provisioning (to Authentication)

Two-step, because Authentication's engine creates its user record at sign-up, before verification ([design decisions](design-decisions.md) §1):

1. `reserve({ requestId, kind: 'person', homeTenantId?, correlationId })` issues a `pending` identity. It is idempotent by `requestId` and receives no personal data.
2. `confirm({ identityId, correlationId })`, once the sign-in identifier is verified, creates the personal group and its membership, makes the identity `active` and writes `identity.provisioned`, in one transaction. Idempotent.
3. `signInStatus(identityId)` is always a `strong` read. It answers `allowed` (active), `resume-only` (paused), `cancel-closure-only` (closure-pending), `verification-only` (pending) or `refused`, and `passkeyOnly` for break-glass identities.

An unconfirmed identity is closed after `pendingConfirmationHours`, and `identity.provisioning-expired` tells Authentication to discard the unverified account.

### 10.2 Provided: directory (to Authorisation, through the host)

`resolveActor(identityId, { consistency })` and `describeGroup(groupId, { consistency })`, in Identity's own vocabulary:

- the actor context carries the identity's kind and state, its personal group, and the memberships in effect now (effective status `active`, `paused` or `suspended`), each with its own state, kind, owner flag and dates;
- a group description carries its tenant, lineage (root first, ending with the group), kind and state;
- `strong` reads come from the source of truth; `bounded` reads may be cached for at most `IDENTITY_MAX_STALENESS_SECONDS` (30);
- unknown and `pending` identities, and unknown groups, are `null`; a failure **rejects**, never answering null, partial or stale data.

The host adapts this to Authorisation's `AuthorisationDirectory`. The reference adapter in iam-integration maps an effective status of `paused` to `suspended` for Authorisation contract 2, and passes `paused` through for contract 3. Identity's contract does not change when Authorisation's does. The conformance suite (§14) proves an adapter keeps these guarantees.

### 10.3 Provided: disclosure context (to Profile)

`describe({ viewerId, subjectIds (1 to 200), groupId | null }, { consistency })` answers, for each subject:

- `relationship`: `self`, `same-group`, `former-member` (the subject's membership of the group context has ended and the viewer's is in effect), `same-tenant` or `none`. Personal groups never relate two identities. If the viewer holds no membership in effect in the group context, the context is ignored and the answer says nothing about that group;
- `standing`: `visible`, `paused`, `suspended`, `closing` or `gone`;
- `membershipInGroup`: the subject's membership kind, state and end time in the group context, when the viewer may know of it;

and, when a group context applies, the group's **departure data policy**. Normally read `bounded`. A failure rejects, and Profile shows no name rather than a stale one. Whether the viewer is an administrator (to see a suspended member) is a question Profile asks Authorisation.

### 10.4 Consumed

| Port | Supplied from | Purpose | Required |
|---|---|---|---|
| `IdentityDatabase` | Host | PostgreSQL pool for the `identity` schema (ADR-0002) | Yes |
| `IdentityAccessDecision` | Authorisation | May this subject exercise this Identity permission on this group? | Yes |
| `IdentityApprovalPolicy` | Authorisation | A permission's risk; whether an approver qualifies now; how many others qualify (for the route) | Yes |
| `IdentityEventPublisher` | Host's outbox relay | Publishes each outbox event at least once | Yes |
| `IdentityPolicy` | Host | Overrides within bounds (§15) | No |

`IdentityAccessDecision` is an addition to iam-integration's architecture §3, which listed only the approval-policy port; see [design decisions](design-decisions.md) §8.

## 11. Events

Written to Identity's transactional outbox in the same transaction as the change, relayed by the host, delivered at least once. Every event has an `eventId` (UUIDv7), `type`, `occurredAt`, `correlationId`, `actorId` (null for the system), `aggregate` (`type`, `id`, `version`), `tenantId` and a strict `data` payload of identifiers, codes and instants.

| Event | Payload | Consumers |
|---|---|---|
| `identity.provisioned` | identity, kind, home tenant, personal group | Profile (create an empty record) |
| `identity.provisioning-expired` | identity | Authentication (discard the unverified account) |
| `identity.paused`, `.resumed` | identity | Authentication (revoke other sessions on pause), Profile, notifications |
| `identity.suspended`, `.reinstated` | identity, reason code, change or break-glass review | Authentication, Profile, Authorisation |
| `identity.closure-requested`, `.closure-cancelled`, `.closed` | identity (and `closesAt`, personal group) | Authentication, Profile, Authorisation, domain capabilities |
| `membership.added`, `.paused`, `.resumed`, `.suspended`, `.reinstated`, `.dates-changed`, `.ended` | membership, identity, group (and kind, owner, dates, end reason, reason code) | Authorisation (caches; default or guest role), Profile, domain capabilities |
| `group.created`, `.renamed`, `.reparented`, `.owners-changed`, `.settings-changed`, `.orphaned`, `.archived` | group (and lineage, owners, changed settings) | Authorisation; Profile (`settings-changed` for the departure policy) |
| `invitation.accepted`, `invitation.refused` | invitation, group, inviter, accepting identity, whether it awaits confirmation | Notification capabilities (tell the inviter and, when confirmation is needed, the group's administrators) |
| `tenant.created`, `tenant.closing` | tenant (and jurisdiction, region) | All members |
| `approval.requested`, `approval.decided` | change, type, group, risk, route, outcome | Notification capabilities |
| `break-glass.used`, `break-glass.review-closed` | review, break-glass identity, action, target, reason code | Host alerting (every operator and affected owner), audit |

`PROFILE_CONSUMED_EVENT_TYPES` and `AUTHENTICATION_CONSUMED_EVENT_TYPES` list each consumer's events. Access never depends on an event arriving: Authorisation reads membership state from the directory at decision time.

## 12. Errors

| Code | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | No signed-in subject |
| `forbidden` | 403 | Refused, **or the identity, group, membership or invitation does not exist**. Never says which (improvement register item 12) |
| `insufficient-assurance` | 403 | Permitted after step-up |
| `validation-failed` | 400 | Malformed input, including an unsafe group name (with its problem code) |
| `conflict` | 409 | A governance rule refused it (last owner, cycle, depth), reported only after the caller has been authorised to see the resource |
| `rate-limited` | 429 | Too many invitations or acceptance attempts |
| `unavailable` | 503 | Database, Authorisation or another port failed. Fails closed |

## 13. Break-glass (ADR-0007)

A `break-glass` identity has no personal group, memberships or roles, and signs in with a passkey only (`passkeyOnly` in the sign-in status). `refuseBreakGlass` allows exactly three actions: suspend an identity, suspend a membership, and appoint an owner to an **orphaned** standard group, never itself. Each takes effect at once, writes `break-glass.used` with a reason code, and opens a review (`breakGlassReviewSchema`) that only another person, who did not hold the passkey, can close (`mayCloseReview`, permission `identity.break-glass-reviews:close`). Authentication rotates the passkey after each use.

## 14. Conformance suite

`identityDirectoryConformance({ directory, fixture, boundedStalenessSeconds })` (improvement register item 1) returns framework-free checks for any directory implementation or adapter. They cover: null for unknown and pending identities; schema-valid answers; lineage and tenant; rejecting on failure for strong reads, and for bounded reads with nothing cached; an ended membership disappearing at once on a strong read and within the bound on a bounded one; a paused identity's memberships reported paused; dates honoured; and personal groups never listed as memberships. Identity's own tests show it catches faulty adapters.

## 15. Policy

`resolveIdentityPolicy(input)` merges host overrides onto the defaults (improvement register D3). Tightening is free. Loosening a setting past its default needs a `riskTreatment` reference, and values outside the hard bounds are refused.

| Setting | Default | Bounds | Safer when |
|---|---|---|---|
| `closureGraceDays` | 30 | 7–90 | longer |
| `pendingConfirmationHours` | 24 | 1–72 | shorter |
| `approvalExpiryDays` | 7 | 1–14 | shorter |
| `publishedDelayHighHours` | 72 | 24–336 | longer |
| `publishedDelayCriticalHours` | 168 | 72–720 | longer |
| `orphanRecoveryDelayDays` | 14 | 7–60 | longer |
| `recoveryHoldHours` | 72 | 24–336 | longer |
| `invitationExpiryDays` | 14 | 1–30 | shorter |
| `guestTermDays` | 90 | 1–365 | shorter |
| `maxHierarchyDepth` | 10 | 1–32 | shorter |
| `invitationsPerInviterPerHour`, `invitationsPerGroupPerDay`, `acceptanceAttemptsPerHour` | 50, 200, 20 | see `IDENTITY_POLICY_BOUNDS` | shorter |

The policy also lists the `jurisdictions` and `dataRegions` the host supports and the `defaultHomeTenantId`.

## 16. SCIM

Identity supplies the structural part of SCIM 2.0 resources (improvement register item 5): `id`, `externalId` (per tenant for identities), `active` (true for `active` and `paused`), a group's `displayName` and `members`, and `meta` with a weak ETag from the aggregate version. `userName` comes from Authentication and `name` and `emails` from Profile; a SCIM endpoint composed by the host merges them.

## 17. Versioning

This is contract version 1, provided by package 0.1. Before 1.0, breaking changes are listed here and in the release notes. Reserved for later versions: further `pausing` values (`notice`, `approval`), identity-provider group-claim mapping (improvement register item 18), and the tenancy module's extraction.
