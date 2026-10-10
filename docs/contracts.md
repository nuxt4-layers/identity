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
| `break-glass` | None | ADR-0007: no standing privileges, passkey only, three actions (§13) |

| State | Meaning |
|---|---|
| `pending` | Issued at sign-up, before Authentication has verified the sign-in identifier. Not in the directory, no access, no events. Closed if not confirmed within `pendingConfirmationHours` (24) |
| `active`, `paused`, `suspended`, `closure-pending`, `closed` | As in iam-integration's state models §1 |

Permitted transitions are listed in `IDENTITY_TRANSITIONS`; anything else is refused:

| Action | From | To | By |
|---|---|---|---|
| `confirm` | `pending` | `active` | system, on Authentication's confirmation |
| `expire` | `pending` | `closed` | system |
| `pause` / `resume` | `active` / `paused` | `paused` / `active` | the person only (pausing after reauthentication) |
| `suspend` | `active`, `paused` | `suspended` | an administrator with approval at `high` risk, or a break-glass account |
| `reinstate` | `suspended` | the previous state | an administrator with approval |
| `request-closure` | `active`, `paused`, `suspended` | `closure-pending` | the person only, after reauthentication |
| `cancel-closure` | `closure-pending` | the previous state | the person only, after reauthentication |
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

A group becomes `orphaned` as soon as no owner is in effect (an active membership, within its dates, of an active person), whatever caused it: an owner paused, suspended, closed or lapsed. It becomes `active` again when one returns or is appointed (§8.3). Both are recorded in the same transaction as the change that caused them and announced (`group.orphaned`, `group.recovered`). Archiving does not orphan a group.

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
- Acceptance and declining answer `INVITATION_ACKNOWLEDGEMENT` whenever the request is well formed and within the rate limit, whatever happened, so they cannot be used to probe for groups, identities or tokens. Creating an invitation returns the token to an authorised inviter (`identity.invitations:manage`), once; an unknown group and a refused inviter are both `forbidden`.
- **No self-admission.** The inviter cannot accept their own unbound invitation, and nobody confirms their own acceptance.
- Rate limits: `invitationsPerInviterPerHour` (50), `invitationsPerGroupPerDay` (200), `acceptanceAttemptsPerHour` (20). Every acceptance or decline counts as an attempt, whether or not the token is real.
- An invitation may carry `membershipStartsAt` and `membershipEndsAt` for scheduled joiners and leavers. A guest's end defaults to the group's guest term from joining, and may not exceed it.
- Whether the membership can be created is checked when it is created, at acceptance or confirmation: the group and tenant are active, guests are still allowed, the person is active and not already a member. If not, nothing is created.
- **Home tenant.** Authentication may pass the token to `reserve` (`invitationToken`) when someone signs up through an invitation. Identity resolves the inviting tenant on the server from an open, unbound invitation, and falls back to the default otherwise, revealing nothing. Reserving does not use the invitation up.

### 7.1 Join requests

Where a group's `joining.open` is on, anyone already in its tenant (their home tenant, or a membership in effect there) joins at once as a `member`. Otherwise, where `joining.requests` is on, they record a request (`joinRequestSchema`): one open request per person and group, expiring after `approvalExpiryDays` (7). An administrator with `identity.join-requests:decide` approves, which creates the membership, or refuses; nobody decides their own request (`refuseJoinDecision`). The person may withdraw. A group in another tenant, or an unknown group, is `forbidden`; one that takes neither requests nor open joining is a `conflict`. Events: `join-request.created`, `join-request.decided` (`approved`, `refused`, `withdrawn`, `expired`).

## 8. Governance approvals

Identity owns pending **governance** changes; Authorisation owns pending role and grant changes. Both follow iam-integration's [approvals process](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/processes/approvals.md).

**Changes Identity records** (`GOVERNANCE_CHANGES`): create a root group, reparent, archive, change settings, change approval requirements, change safety periods (§21), add, remove or suspend an owner, appoint an owner to an orphaned group, reinstate or reschedule a membership, suspend or reinstate an identity, and create a service identity. Each names the permission it exercises (§9) and whether it **confers** something on its beneficiary.

**A pending change records** its requester, **beneficiary**, risk, **justification** (a reason code, and a reference where the group requires one), the approvals required, the route, the approvals given (approver, decision, time, assurance and the digest they approved), a digest of the exact change, the expiry or delay, and the correlation identifier.

**Rules:**

1. **No self-grant at any risk level** (`refuseRequest` → `self-grant`). Outside their own personal group, nobody requests a change that confers ownership, a reinstatement, an appointment or new membership dates on themselves.
2. **Approvers** (`refuseApproval`) are never the requester, never the beneficiary, never an identity the requester controls (the service identities created by `service-identity.create` changes they requested, as `getIdentityAccessGovernance` lists them: only active people approve, so the database refuses every one of them), and must still qualify at decision time: Identity asks Authorisation with a `strong` read when the approval is given. Each approver decides once.
3. **Exact change.** An approval is bound to the change's digest; a change that differs needs a new approval.
4. **Assurance.** Requesters and approvers meet `STEP_UP_REQUIREMENTS` for the risk: `high` needs aal2; `critical` needs phishing-resistant aal2 within the last 15 minutes.
5. **Requirement.** `approvalRequirement` takes the group's setting, never below the floor (`low` and `medium`: 0 beyond a requester who is never the beneficiary; `high` and `critical`: 1). Raising it is `critical`.
6. **Routes** (`chooseRoute`): qualifying approvers in the group; otherwise an owner of the parent group; otherwise an owner of the tenant's root group; otherwise a **published delay** of `publishedDelayHighHours` (72 by default) or `publishedDelayCriticalHours` (168) that the requester cannot shorten and may cancel. A change awaiting an approver expires after `approvalExpiryDays` (7). Each is the value in force for the group (§21).
7. **Personal-group sovereignty.** In their own personal group a person needs **no approver**, including to share what it owns with others (sharing itself is an Authorisation grant, under the same rule), but must still **step up** to the risk level's assurance, which protects them if a session is stolen.
8. **Recovery hold.** After credential recovery, `critical` governance changes the recovered person requests are held for `recoveryHoldHours` (72 by default; the value in force for the change's group, §21) and announced to their groups' co-owners. The host relays Authentication's `authentication.credentials-recovered` to `recordIdentityCredentialRecovery` (§18). A held change records `heldUntil`; `approval.held` announces it; approved before the hold ends, it waits as `delayed` and maintenance applies it when the hold ends. The database applies the hold itself, never shorter than 24 hours.

### 8.1 Requesting a change

A requester submits a `governanceRequestSchema`: the change `type`, its `target` (`GOVERNANCE_TARGETS`) and a `justification`. `group.appoint-owner` belongs to orphaned-group recovery and is not requested this way.

| Change | Target | Decided in | Beneficiary |
|---|---|---|---|
| `group.create-root` | tenant, safe name, first owner | the platform group | the first owner |
| `group.reparent` | group, new parent (same tenant; the requester needs the permission on both) | the group | none |
| `group.archive` | group (refused while a child is not archived, or a service identity it owns is active; ends memberships when `onArchive` is `end-memberships`) | the group | none |
| `group.change-settings` | group, every setting except `approvals` | the group | none |
| `group.change-approvals` | group, `approvals` (never below the floor) | the group | none |
| `group.change-safety-periods` | group, its own `safetyPeriods` (§21) | the group | none |
| `group.add-owner` | an active member's membership (never a guest) | the group | the member |
| `group.remove-owner`, `group.suspend-owner` | an owner's membership (never the last active owner; suspending oneself is refused) | the group | the owner |
| `membership.reinstate` | a suspended membership | the group | the member |
| `membership.schedule` | a membership, new `startsAt` and `endsAt` (a guest's end within the group's guest term and the policy's) | the group | the member |
| `identity.suspend`, `identity.reinstate` | a person or service identity (never oneself) | the platform group | the identity |
| `service-identity.create` | the owning group | the group | none |
| `group.appoint-owner` | an active member's membership of an orphaned group (§8.3) | owners above the group, or a platform operator on objection | the member |

The order of checks keeps errors coarse (§12): the target is located (unknown → `forbidden`), the requester authorised through the access-decision port on the group that decides (refused → `forbidden`), and only then are rules reported (`conflict`): self-grant, a rule about the target, a missing reference (`validation-failed`). The risk is the higher of Identity's (§9) and the host catalogue's; the requester must meet its step-up (`insufficient-assurance`). Only an active person requests or approves.

The **route** is chosen when the change is recorded: `none` (it applies at once, or nothing is recorded); `approvers` when enough principals other than the requester and the beneficiary qualify in the group; otherwise one owner of the **parent group**, then one owner of the **tenant's root group**, other than requester and beneficiary; otherwise a **published delay**. A change awaiting an approver expires after `approvalExpiryDays`. Approval requirements raised to 2 apply to the `approvers` route; the owner fallbacks ask for one owner.

`request`, `decide`, `cancel` and `getPendingChange` (§18) return the pending change. `decide` takes the digest of the change the approver was shown. A change is visible to its requester, its beneficiary and anyone who may decide it; to anyone else it is `forbidden`.

### 8.2 What the database holds as well

Pending changes are recorded, decided, cancelled and applied only through SECURITY DEFINER functions; the runtime role may read them, under row-level security, and nothing else. Those functions check again what the database can know, whatever the layer sends: the risk is never below Identity's declared risk; the requirement never below the group's; no self-grant; a justification and, where required, a reference; a published delay, expiry and recovery hold no less safe than the periods in force for the group (§21), and never beyond the hard bounds; an approver who is an active person, neither requester nor beneficiary, not deciding twice, and, for the owner fallbacks, an owner now. The digest is computed by the database over everything the change will do and checked again before it applies, so an altered record cannot be applied.

When a change applies, every rule is checked again: the group is still active, the membership has not ended, the last owner stays, the hierarchy has no cycle and is within `maxHierarchyDepth` including the moved group's descendants, the guest term holds. If one no longer holds, the change is `rejected` and `approval.decided` says so. Every event the change causes carries the change's correlation identifier and, where the payload has one, its `changeId`.

### 8.3 Orphaned-group recovery

Following iam-integration's recovery process, `group.appoint-owner` makes an active member (never a guest) the owner of an orphaned group. It is `critical`, and the authority comes from Identity's own record of ownership rather than a permission:

1. An **owner of the parent group or of the tenant's root group** proposes any active member but themselves. Another owner above approves (`parent-owner`, then `tenant-owner`); where none exists, the change applies after a published delay of `orphanRecoveryDelayDays` (14 by default; the value in force, §21).
2. Where **no owner exists above** (an orphaned root group, or no owners left above it), an active member may propose the group's **longest-standing active member**, themselves included, through the published delay only. During the delay any active member but the proposer may **object** (`object`), recorded as an approval record with decision `object`: automatic appointment stops and the change moves to the `platform-operator` route, decided by a qualifying member of the host's platform group before `approvalExpiryDays`.

Members of the group may see its recovery to object to it. A break-glass identity may also appoint an owner at once (§13). Recovery never reads a personal group, and personal groups are never orphaned.

## 9. Permissions

Identity's permissions follow Authorisation's grammar (`<resource>:<action>`). The host adds `IDENTITY_PERMISSIONS` to Authorisation's catalogue. Each declares its `effect` for Authorisation contract 3: the three `:view` permissions are `view`, every other one `change`. A paused member therefore still sees the group, its members and its tenant, and changes nothing.

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

1. `reserve({ requestId, kind: 'person', homeTenantId? | invitationToken?, correlationId })` issues a `pending` identity. It is idempotent by `requestId` and receives no personal data. With an invitation token, the inviting tenant becomes the home tenant (§7).
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

### 10.4 Provided: access governance (to Authorisation, through the host)

Authorisation records its own pending role and grant changes and applies the same approval rules Identity applies to governance changes ([access administration](https://github.com/nuxt4-layers/iam-integration/blob/35e86ab288fed79848b513a98cfbd98304a3cb26/docs/processes/access-administration.md)). `getIdentityAccessGovernance()` gives it Identity's facts, in Identity's own vocabulary, every read `strong` and timed by the clock:

- `describeGroup({ groupId, identityId, correlationId })` answers `governedGroupSchema`: the group's tenant, kind, state, parent (`null` for a root or personal group) and root (the first of its lineage, itself for a root or personal group); for a personal group, whose it is (`personalOfIdentityId`); its approval requirement and reference rule (§5.5; the defaults for a personal group); the safety periods in force for it (§21: `publishedDelayHighHours`, `publishedDelayCriticalHours`, `approvalExpiryDays`, `recoveryHoldHours`; the platform's for a personal group); and, for the identity named as requester, the end of their recovery hold if one is running now (§8) and the identities they control (service identities created by `service-identity.create` changes they requested, not closed), which never approve for them. An unknown group is `null`;
- `isOwner({ identityId, groupId })`: whether Identity records the identity as an owner of the group in effect now (an active membership within its dates, of an active person), as the owner fallbacks of the approval route read it;
- `countOwners({ groupId, excluding })`: how many such owners the group has, other than those listed, as the route counts them.

It decides nothing and checks no permission: the host calls it from its adapter, server-side only, and never over HTTP. It reveals group settings, safety periods and owner counts, never personal data. Malformed input is `validation-failed`; a failure **rejects** (`unavailable`), never answering null, partial or stale data.

### 10.5 Consumed

| Port | Supplied from | Purpose | Required |
|---|---|---|---|
| `IdentityDatabase` | Host | PostgreSQL pool for the `identity` schema (ADR-0002) | Yes |
| `IdentityAccessDecision` | Authorisation | May this subject exercise this Identity permission on this group? | Yes |
| `IdentityApprovalPolicy` | Authorisation | A permission's risk; whether an approver qualifies now; how many others qualify (for the route) | Yes |
| `IdentityEventPublisher` | Host's outbox relay | Publishes each outbox event at least once | Yes |
| `IdentityPolicy` | Host | Overrides within bounds (§15) | No |
| `IdentitySubjectResolver` | Authentication, through the host | Who is signed in, for the HTTP endpoints (§19): the host adapts `getAuthenticatedPrincipal(event)` | For the endpoints; without it every endpoint answers `unavailable` |
| `IdentityClock` | Host (the suite's one clock) | The current time (`now()`) for everything Identity keeps or judges: safety periods, delays, expiries, the closure grace period, the recovery hold, recent authentication, and every database transaction's time (`identity.at`), which the database's own checks and triggers read | No; without it, the system clock. A clock that throws or answers no valid date fails the operation as `unavailable` |

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
| `group.created`, `.renamed`, `.reparented`, `.owners-changed`, `.settings-changed`, `.orphaned`, `.recovered`, `.archived` | group (and lineage, owners, changed settings, the change or break-glass review behind a recovery) | Authorisation; Profile (`settings-changed` for the departure policy) |
| `invitation.accepted`, `invitation.refused` | invitation, group, inviter, accepting identity, whether it awaits confirmation | Notification capabilities (tell the inviter and, when confirmation is needed, the group's administrators) |
| `join-request.created`, `join-request.decided` | request, group, identity, outcome | Notification capabilities (tell the group's administrators, then the person) |
| `tenant.created`, `tenant.closing` | tenant (and jurisdiction, region) | All members |
| `approval.requested`, `approval.decided`, `approval.held` | change, type, group, risk, route, outcome, the end of a recovery hold | Notification capabilities (tell approvers; on a hold, the group's co-owners; on recovery, the group's members) |
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

Over HTTP an error is an `IdentityErrorBody`: `{ code, messageKey }`, and for `conflict` and `validation-failed` only, `reason`, the rule as a code (`last-owner`, `self-grant`, `forbidden-character`), for a caller already entitled to learn it. `forbidden` never carries a reason.

## 13. Break-glass (ADR-0007)

A `break-glass` identity has no personal group, memberships or roles, and signs in with a passkey only (`passkeyOnly` in the sign-in status). The operator provisions it with the migration role (`provisionIdentityBreakGlass`). `refuseBreakGlass` allows exactly three actions: suspend an identity, suspend a membership, and appoint an owner to an **orphaned** standard group, never itself. Each needs phishing-resistant aal2 within 15 minutes, takes effect at once, writes `break-glass.used` with a reason code, names the review in the events it causes (`breakGlassReviewId`), and opens a review (`breakGlassReviewSchema`) that only another person, who did not hold the passkey, can close (`mayCloseReview`, permission `identity.break-glass-reviews:close` in the platform group). Authentication rotates the passkey after each use. Reviews are never granted to the runtime role.

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

The six safety periods among these (`publishedDelayHighHours`, `publishedDelayCriticalHours`, `approvalExpiryDays`, `orphanRecoveryDelayDays`, `recoveryHoldHours`, `closureGraceDays`) are starting values: the platform's operators and owners may change them while the platform runs (§21).

The policy also lists the `jurisdictions` and `dataRegions` the host supports, the `defaultHomeTenantId`, and the `platformGroupId`: the standard group whose owners and qualifying members are the platform's operators, where root groups and identity suspension are decided. With none, those changes are refused.

## 16. SCIM

Identity supplies the structural part of SCIM 2.0 resources (improvement register item 5): `id`, `externalId` (per tenant for identities), `active` (true for `active` and `paused`), a group's `displayName` and `members`, and `meta` with a weak ETag from the aggregate version. `userName` comes from Authentication and `name` and `emails` from Profile; a SCIM endpoint composed by the host merges them. Identity supplies them through the server function `getIdentityScimStructure()` (`user({ identityId, tenantId })`, `group({ groupId })`), not over HTTP: the composed endpoint is the host's (iam-integration), and members do not call one another over HTTP. Break-glass and pending identities have no SCIM resource; a group's `members` are those whose membership is in effect now, active or paused.

## 18. Server functions

The host calls these on the server; none is an HTTP route. Each uses the supplied ports and fails closed (`IdentityCompositionError`) when one is missing.

| Function | Purpose | Errors |
|---|---|---|
| `migrateIdentityDatabase({ pool, runtimeRole, schema? })` | Applies migrations with the **migration** pool, granting the runtime role only what it needs. Refuses a runtime role that is a superuser, has `BYPASSRLS` or is the migration role | Throws; nothing is applied |
| `getIdentityProvisioning()` | The provisioning port (§10.1) | `validation-failed` (malformed input, unknown or inactive home tenant), `forbidden` (unknown identity), `conflict` (not pending, or past its confirmation window), `unavailable` |
| `getIdentityDirectory()` | The directory port (§10.2). Always reads the source of truth | `unavailable`: the port rejects, never answers null for a failure |
| `getIdentityAccessGovernance()` | The access-governance port (§10.4), for the host's adapter to Authorisation: `describeGroup`, `isOwner`, `countOwners`. Always reads the source of truth; decides nothing. Server-only | `validation-failed` (malformed input), `unavailable`: the port rejects, never answers null for a failure |
| `relayIdentityOutbox({ limit? })` | Publishes up to `limit` (default 100) outbox events in order, at least once. Returns `{ published, failed }` | `unavailable` |
| `getIdentityDisclosureContext()` | The disclosure-context port (§10.3), for the host's adapter to Profile | `validation-failed`, `unavailable` |
| `getIdentityGovernance()` | Changes that need no second approver: `createGroup` (child group, `identity.groups:create`; the creator becomes founding owner), `renameGroup` (`identity.groups:rename`), `pauseMembership`, `resumeMembership` and `leaveGroup` (the member's own), and `actOnMember` (`remove` or `suspend` a member who is not an owner, with a reason code). Each takes the authenticated `subject` and a `correlationId` | `validation-failed` (malformed input, unsafe name), `forbidden` (unknown target, or refused by Authorisation), `insufficient-assurance`, `conflict` (last owner, personal group, confusable sibling name, depth, owner needing approval), `unavailable` |
| `getIdentityApprovals()` | Governance changes that need approval (§8): `request({ subject, request, correlationId })`, `decide({ subject, changeId, changeDigest, decision, correlationId })`, `cancel({ subject, changeId, correlationId })` (the requester only), `object({ subject, changeId, correlationId })` (a member, against an orphaned group's recovery) and `getPendingChange({ subject, changeId })`. Needs the access-decision and approval-policy ports | `validation-failed`, `forbidden`, `insufficient-assurance`, `conflict` (a rule, `self-grant`, not pending, a different digest, already decided), `unavailable` (including a permission missing from the host's catalogue) |
| `getIdentityJoining()` | Joining a group (§7, §7.1): `invite` (returns the token once), `accept` and `decline` (the token's holder; always `INVITATION_ACKNOWLEDGEMENT`), `revoke`, `decideAcceptance` (`confirm` or `refuse` who accepted), `listInvitations`; `requestToJoin` (`joined` or `requested`), `withdrawJoinRequest`, `decideJoinRequest` (`approve` or `refuse`), `listJoinRequests` | `validation-failed`, `forbidden`, `insufficient-assurance`, `conflict` (guests not allowed, already a member, own acceptance or request, not pending, joining closed), `rate-limited`, `unavailable` |
| `getIdentityLifecycle()` | The person's own lifecycle (§3): `pauseIdentity` (returns the groups it orphans), `resumeIdentity`, `requestClosure` (`leaveGroupsOrphaned` to proceed as a last owner; closes after `closureGraceDays`), `cancelClosure`, `lastOwnerOf`. Pausing, requesting and cancelling closure need authentication within 15 minutes (`REAUTHENTICATION_MAX_AGE_SECONDS`) | `validation-failed`, `forbidden`, `insufficient-assurance`, `conflict` (`last-owner`, wrong state), `unavailable` |
| `recordIdentityCredentialRecovery({ identityId, recoveredAt, correlationId })` | Records Authentication's `authentication.credentials-recovered` for the recovery hold (§8). Returns whether the identity is known | `validation-failed`, `unavailable` |
| `getIdentityBreakGlass()` | Break-glass (§13): `act` and `closeReview` | `validation-failed`, `forbidden`, `insufficient-assurance`, `conflict`, `unavailable` |
| `provisionIdentityBreakGlass({ pool, schema?, homeTenantId, correlationId })` | The operator's provisioning of a break-glass identity, with the migration pool. Writes `identity.provisioned` (kind `break-glass`) | `validation-failed`, `unavailable` |
| `getIdentityQueries()` | Reads for administration (§19): `self`, `group` (`identity.groups:view`), `members` (`identity.memberships:view`, 100 a page), `changes` (`identity.groups:view`) | `validation-failed`, `forbidden`, `insufficient-assurance`, `unavailable` |
| `exportIdentityData({ identityId, correlationId })` | Identity's part of a data-subject access request (`identityExportSchema`): the identity, its external identifiers and every membership, ended ones included. Server-only, for the verified request in iam-integration's data-subject request process. Null when unknown | `validation-failed`, `unavailable` |
| `getIdentityScimStructure()` | The structural part of SCIM users and groups (§16). Server-only | `validation-failed`, `unavailable` |
| `runIdentityMaintenance()` | Closes `pending` identities past their confirmation window (`identity.provisioning-expired`), records memberships past their end date as `ended` (`expired`, `membership.ended`), expires changes nobody approved in time, applies changes whose published delay has ended, and expires invitations, acceptances unconfirmed after `approvalExpiryDays` and join requests, and closes identities at the end of their grace period (memberships end; their pending changes, invitations and join requests are withdrawn; `identity.closed`). Returns the counts | `unavailable` |
| `provisionIdentityTenant({ pool, schema?, jurisdiction, dataRegion, externalId?, correlationId })` | The platform operator's tenant provisioning, with the **migration** pool; the runtime role cannot create tenants. The jurisdiction and region must be registered in the policy. Writes `tenant.created` | `validation-failed`, `unavailable` |
| `bootstrapIdentityRootGroup({ pool, schema?, tenantId, name, firstOwnerId, correlationId })` | The operator's bootstrap of a tenant's first root group and founding owner (an active person), with the migration pool. Refused once the tenant has a root group: later ones are `group.create-root` changes. Writes `group.created` and `membership.added` with a null actor | `validation-failed`, `conflict`, `unavailable` |

`IdentityError` carries the contract code; its message is for the server log only, except that for `conflict` and `validation-failed` the HTTP endpoints pass the rule on as `reason` when it is a code (§12).


## 19. Administration API

The layer mounts these endpoints under `/api/identity` (`IDENTITY_API_PREFIX`). Each takes the subject only from the host's `IdentitySubjectResolver`, never from the request; parses JSON bodies with strict schemas; decides through the same server functions (§18), so every permission, approval, step-up and rule above applies; and answers errors as §12 describes. State-changing requests must carry an `Origin` (or `Referer`) matching `NUXT_IDENTITY_BASE_URL`; without one configured, all are refused. A client may send `x-correlation-id` (a UUID); otherwise the endpoint issues one.

| Method and path | Does | Server function |
|---|---|---|
| `GET /me` | The signed-in identity's own view (`selfViewSchema`): its actor context, the names of its groups and of the standard groups it has left (`formerGroupNames`), and the groups it alone owns | `getIdentityQueries().self` |
| `POST /me/pause`, `POST /me/resume` | Pauses (after reauthentication) or resumes the identity | `getIdentityLifecycle()` |
| `POST /me/closure`, `DELETE /me/closure` | Requests (`{ leaveGroupsOrphaned? }`) or cancels closure, after reauthentication | `getIdentityLifecycle()` |
| `POST /groups` | Creates a child group (`{ parentGroupId, name }`); 201 | `getIdentityGovernance().createGroup` |
| `GET /groups/:groupId`, `PATCH /groups/:groupId` | Shows (`groupViewSchema`) or renames (`{ name }`) a group | `getIdentityQueries().group`, `getIdentityGovernance().renameGroup` |
| `GET /groups/:groupId/members?after=` | A page of live memberships with their effective status (`groupMembersPageSchema`) | `getIdentityQueries().members` |
| `GET /groups/:groupId/changes` | Pending governance changes | `getIdentityQueries().changes` |
| `GET /groups/:groupId/invitations`, `GET /groups/:groupId/join-requests` | The group's invitations and open join requests | `getIdentityJoining()` |
| `POST /groups/:groupId/join` | Joins an open group, or asks to join | `getIdentityJoining().requestToJoin` |
| `POST /memberships/:membershipId/pause`, `/resume`, `/leave` | The member's own actions | `getIdentityGovernance()` |
| `POST /memberships/:membershipId/suspend`, `/remove` | An administrator's, with `{ reasonCode }` | `getIdentityGovernance().actOnMember` |
| `POST /invitations/accept`, `POST /invitations/decline` | The token's holder (`{ token }`); always `INVITATION_ACKNOWLEDGEMENT` unless rate-limited | `getIdentityJoining()` |
| `POST /invitations/:invitationId/revoke`, `/decision` | Revokes, or confirms or refuses who accepted (`{ decision }`) | `getIdentityJoining()` |
| `POST /join-requests/:joinRequestId/withdraw`, `/decision` | Withdraws, or approves or refuses (`{ decision }`) | `getIdentityJoining()` |
| `POST /changes` | Requests a governance change (`{ request }`); 201 | `getIdentityApprovals().request` |
| `GET /changes/:changeId` | A pending change, to those who may see it | `getIdentityApprovals().getPendingChange` |
| `POST /changes/:changeId/decision`, `/cancel`, `/objection` | Approves or rejects (`{ decision, changeDigest }`), cancels, objects | `getIdentityApprovals()` |
| `POST /break-glass/actions` | A break-glass action (`{ action, targetId, reasonCode }`); 201 | `getIdentityBreakGlass().act` |

Deliberately **not** endpoints, because they need something only the host has:

- **Creating an invitation.** The address must never reach Identity (§7). The host's own endpoint calls `getIdentityJoining().invite` and hands token and address to its delivery.
- **Closing a break-glass review.** The host attests whether the closer held the passkey.
- **Operator procedures, credential recovery, data-subject exports, SCIM.** Server-only by design (§18).

`useIdentity()` is the client side: one function per endpoint, using `useRequestFetch()`. It is for the user experience only and decides nothing.

## 20. Presentation

The layer registers default pages and `Identity*` components (`modules/presentation.ts`), which a host configures in its `nuxt.config.ts` under `identity`:

| Page | Default path | Shows |
|---|---|---|
| `account` | `/account/groups` | The signed-in person's account state and groups; pausing, resuming, leaving and closing, which are theirs alone |
| `group` | `/groups/:groupId` | A group, and the sections the person may see: members (with suspend and remove), invitations (confirm, refuse, revoke), join requests, pending changes; renaming, creating a child group, asking to join |
| `invitation` | `/invitations/accept` | Accepting or declining an invitation. The token travels in the link's fragment (`#token`), which browsers never send to a server or in a `Referer` |
| `change` | `/changes/:changeId` | A governance change: what it does, who asked, why, how it is decided, and the actions open to the person (approve or reject, withdraw, object) |

`identity: { pages: { paths: { ... } } }` moves the pages (the group and change paths must keep `:groupId` and `:changeId`); `identity: { pages: { enabled: false } }` keeps the components without the pages; `identity: { presentation: false }` registers nothing. Every page is sent with `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, unless the host sets those headers itself.

**What the pages decide: nothing.** They call `useIdentity()` and show what the server answers; every action is decided again on the server, and a refused section shows nothing. `useIdentity()` is the only way they reach the server, and they import only the contract (`tests/presentation.test.ts`).

**Names.** Identity holds no names of people. `IdentityPersonName` shows a short label from the opaque identifier; a host replaces it with its own `IdentityPersonName` component (same `identityId` prop) that asks Profile, under Profile's disclosure rules. Group names come from Identity.

**Text.** Every word comes from `presentation/messages.ts` (en-GB) through `useIdentityText()`. Hosts change wording or add locales in `app.config.ts` under `identity.messages`, set the locale with `NUXT_PUBLIC_IDENTITY_LOCALE`, and point `identity.routes.signIn` (`NUXT_PUBLIC_IDENTITY_ROUTES_SIGN_IN`) at their sign-in page, to which the pages link with `?redirect=`. Conflicts and validation failures are explained from the error's `reason` (`identity.reason.*`), otherwise from its code.

**Styling.** The pages style only through Theme Manager's SemanticPresentationTheme vocabulary (`identityClasses`), its public `presentation.css` and its size scales, never raw colours or Tailwind's default sizes; a host imports `@nuxt4-layers/identity/tailwind.css` after Theme Manager's stylesheet. Fill, Pen and Edge of one surface share role and state. The deliberate exceptions, which a host's theme must keep legible:

- `pen-muted-default` on `fill-base-default`: hints, notes and definition terms on the card;
- `edge-error-default` on `fill-input-default`: an invalid field's border;
- `edge-base-active` on `fill-base-default`: the keyboard focus indicator.

**Accessibility.** WCAG 2.2 AA: landmarks and one `h1` per page, labelled sections and fields, errors announced and focused, status messages announced politely, keyboard operation throughout, 24-pixel targets, reflow at 320 CSS pixels. Browser tests (`tests/e2e/pages.spec.ts`) run axe's WCAG 2.2 AA rules and check non-text contrast with Theme Manager's real styles.

## 21. Safety periods

The waits that protect people when nobody else can stop a change, following iam-integration's [safety periods](https://github.com/nuxt4-layers/iam-integration/blob/048210f65831f3eb17c0260ce340715cee49f168/docs/processes/README.md#safety-periods). The host's policy gives each a starting value (§15); while the platform runs, three levels may change them, each through a `group.change-safety-periods` change (`identity.group-approvals:manage`, always `critical`):

| Level | Who | May set |
|---|---|---|
| Platform | Owners and qualifying members of the host's platform group (`platformGroupId`) | Any value within the hard bounds. Less safe than the host's value needs a justification `reference` to its risk treatment (`risk-treatment-required`) |
| Tenant | A root group's owners | Safer values for every group under that root (`safety-period-floor` otherwise) |
| Group | The group's owners | Safer values for the group |

`closureGraceDays` belongs to the person, not to any group, so only the platform group sets it (`platform-only`); no group's owners may lengthen how long someone waits to leave.

**In force** (`effectiveSafetyPeriods`): the safest of the platform's value (its own setting, else the host's), the root group's and the group's own. A group's own settings (`safetyPeriodsSchema`) list only what it sets; a missing setting defers to the level above, and a tenant or group may later relax a value back as far as the level above. `GET /groups/:groupId` shows both, and whether the group is the platform group (`groupViewSchema.safetyPeriods`); the default group page shows them and asks for changes.

**A less safe value waits out the old one** (`waitOutHours`). Once approved, a change that makes any period less safe takes effect only after the longer of the current `publishedDelayCriticalHours` and the current value of each delay it shortens, counted from the request; it is held like a recovery hold (`heldUntil`, `approval.held`). A safer value takes effect when approved. A change keeps the periods it was given when requested. Applying announces `group.settings-changed` with `changed: ['safetyPeriods']`.

**What the database holds as well.** Each group's own periods are a column the runtime role cannot write; a change of periods records the platform group and host values it was requested under, in its digest, and on applying checks again that the group is active, its periods unchanged since the request, the values within bounds, and, outside the platform group, nothing less safe than the levels above and no platform-only setting. Whenever any change is recorded, the database checks its delay, expiry and recovery hold against the periods in force for its group, and holds a change of periods until the old values have run. The layer tells it, per transaction, which group is the platform's and the host's values; without them it falls back to the hard bounds. The closure grace period is the layer's to apply, with the database's 7-day floor.

## 17. Versioning

This is contract version 1, provided by package 0.1. Before 1.0, breaking changes are listed here and in the release notes. Reserved for later versions: further `pausing` values (`notice`, `approval`), identity-provider group-claim mapping (improvement register item 18), and the tenancy module's extraction.

Changes before 1.0:

| Phase | Change | Breaking |
|---|---|---|
| 3a | `pendingChangeSchema` gains `target`, `createdId` and `decidedAt`, and its target must match its type | For anyone constructing pending changes; readers gain fields |
| 3a | `IdentityPolicy` gains `platformGroupId` (default null) | No |
| 3a | `provisionIdentityTenant` takes the migration `pool`; the runtime role can no longer create tenants | Yes, for hosts that called it |
| 3b | `provisioningReserveInputSchema` gains `invitationToken`; `joinRequestSchema`, `join-request.*` events and the `join-request` aggregate are added | No |
| 3b | `INVITATION_ACKNOWLEDGEMENT` answers acceptance and declining only; creating an invitation returns its token | Clarification |
| 3c | `group.appoint-owner` is requestable; route `platform-operator`; approval decision `object`; `group.recovered` and `approval.held` events; `REAUTHENTICATION_MAX_AGE_SECONDS` | No |
| 4 | `IdentitySubjectResolver` port; administration schemas (`selfViewSchema`, `groupViewSchema`, `groupMembersPageSchema`, `identityExportSchema`); `IdentityErrorBody.reason` | No |
| 5 | `selfViewSchema` gains `groupNames` (the person's own groups); presentation entry points `./presentation` and `./tailwind.css` | No |
| Safety periods | `group.change-safety-periods`; `safetyPeriodsSchema`, `effectiveSafetyPeriodsSchema` and helpers; `groupViewSchema` gains `safetyPeriods`; `group.settings-changed` may name `safetyPeriods`; migration `0007_safety_periods` | `groupViewSchema` readers gain a field, and anyone constructing it must add it; consumers of `group.settings-changed` must accept the new setting name |
| 5c | `selfViewSchema` gains `formerGroupNames` (the person's groups left, for Profile's page to choose anonymity in one of them); migration `0008_former_group_names`; `DELIBERATE_PAIRINGS` moves to `presentation/pairings.ts` and is no longer auto-imported (still exported from `./presentation`) | Anyone constructing `selfViewSchema` must add the field; hosts that used the auto-imported `DELIBERATE_PAIRINGS` import it from `./presentation` |
| 6 | `getIdentityAccessGovernance()` and `governedGroupSchema` (§10.4), for Authorisation's own pending changes; migration `0009_access_governance`; the consumed ports become §10.5 | No |
