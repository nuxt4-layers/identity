# Threat Model and Control Register

**Scope:** `@nuxt4-layers/identity`, contract version 1.  
**Baseline:** OWASP ASVS 5.0.0 Level 2, with Level 3 requirements for access control, tenant isolation and governance where appropriate (Security Architecture §1). References are to ASVS 5.0.0 chapters; mapping to individual requirement IDs is recorded in the phase 2 verification. Data stores follow the [Data Store Security Standard v0.1](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/standards/data-store-security-v01.md); per-store evidence is in the [composition contract](composition-contract.md) §6.

## 1. Assets

- The integrity of the membership graph: who is a member of what, in which state, and who owns each group. Every access decision in the platform reads it.
- The integrity of governance: owners, settings, approval requirements, and the approvals themselves.
- The confidentiality of structure: whether an identity, group, membership or invitation exists.
- Invitation tokens, which grant membership to whoever holds them.
- The absence of personal data: what a breach of Identity's schema would reveal.

## 2. Trust boundaries

| Boundary | Trusted input | Untrusted input |
|---|---|---|
| Browser → server | Nothing | Every identifier, tenant, group, name and date in a request |
| Authentication → host → Identity | The authenticated subject, read on the server; provisioning calls from the engine's hooks | — |
| Authorisation → host adapters → Identity | Decisions, risk levels and approver qualification | — |
| Identity → host adapters → Authorisation and Profile | Directory and disclosure answers | — |
| Host → database | The `identity` schema | Other capabilities' schemas (never read) |
| Identity → outbox relay | Events (identifiers and codes only) | — |

## 3. Threats and controls

| ID | Threat | Control | Evidence | Status |
|---|---|---|---|---|
| T1 | Personal data accumulates in Identity, widening what most capabilities must handle (ADR-0005) | Only identifiers, codes, instants, digests and group names; strict schemas; every data schema listed and walked | `tests/personal-data.test.ts` | Implemented (contract) |
| T2 | Enumeration of identities, groups, memberships or invitations through errors | One coarse `forbidden` for "not found" and "not allowed"; `conflict` only after authorisation; one acknowledgement for invitation requests (V8) | `tests/contracts.test.ts` | Implemented (contract); endpoints phase 3 |
| T3 | An incomplete identity becomes active, or an unverified sign-up lingers | `pending` state outside the directory; confirmation creates the personal group atomically; expiry after 24 hours | `tests/states.test.ts` | Contract implemented; enforcement phase 2 |
| T4 | Access kept after leaving, or before starting | Effective status evaluated at read time from state, dates and identity state; directory leaves out ended and not-started memberships | `tests/states.test.ts`, conformance suite | Implemented (contract) |
| T5 | A caching directory adapter serves stale or partial membership | `strong` and `bounded` (≤ 30 s) consistency; failure rejects; conformance suite catches faulty adapters | `tests/conformance.test.ts` | Implemented |
| T6 | Self-escalation: a person makes themselves an owner, reinstates themselves or extends their own membership | No self-grant at any risk level outside one's personal group (V8) | `tests/approvals.test.ts` | Contract implemented; enforcement phase 2 |
| T7 | Approval collusion or replay: self-approval, approval by the beneficiary or a requester's service identity, approval of a different change, approval by someone who lost their role | Approver rules; strong qualification check at decision time; digest binding (V8) | `tests/approvals.test.ts` | Contract implemented; enforcement phase 2 |
| T8 | A group weakens its own governance | Approval requirements can be raised, never lowered below the floor; raising is `critical` | `tests/approvals.test.ts` | Contract implemented; enforcement phase 2 |
| T9 | Single-owner groups ungovernable, or governed without oversight | Parent-owner, tenant-owner, then published-delay routes; delay not shortenable, announced, cancellable | `tests/approvals.test.ts` | Contract implemented; enforcement phase 2 |
| T10 | Session theft used for sensitive changes | Step-up by risk for requesters and approvers, including in one's own personal group | `tests/approvals.test.ts` | Implemented (contract) |
| T11 | Privilege gained through the hierarchy, e.g. by reparenting under a group whose administrators should not see it | The hierarchy confers nothing; reparenting is `critical`, same tenant only, cycle-checked, depth-limited | `tests/states.test.ts` | Contract implemented; enforcement phase 2 |
| T12 | Supply-chain compromise | Runtime dependency `zod` only; `minimumReleaseAge`, `blockExoticSubdeps`, frozen lockfile, dependency review | `pnpm-workspace.yaml`, workflows | Implemented |
| T13 | Homoglyph and invisible-character group names used to impersonate a group | Safe names: NFC, forbidden code points, single-script rule; confusable skeleton for siblings | `tests/safe-names.test.ts` | Contract implemented; sibling check phase 2 |
| T14 | Invitation tokens stolen from the database, guessed or brute-forced | 256-bit tokens; only SHA-256 digests stored; single use; 14-day expiry; rate limits on creation and acceptance | `shared/invitation.ts`, policy | Contract implemented; enforcement phase 2 |
| T15 | An invitation forwarded to someone else is accepted | Invitations to an existing identity are bound to it. Unbound invitations wait for an administrator to confirm who accepted when the group's `invitationAcceptance` is `confirm` (the default for guests); nobody confirms their own acceptance; the inviter is told of every acceptance | `tests/invitations.test.ts` | Contract implemented; enforcement phase 3. Residual risk for member invitations left `immediate`, see §4 |
| T16 | Missing port leads to an implicit permissive store, decision or dropped event | Required ports fail closed (ADR-0002) | `tests/composition.test.ts` | Implemented |
| T17 | Cross-tenant access through Identity's own store | Tenant on every isolated row; row-level security with `SET LOCAL`; non-owner runtime role (ADR-0006 §5) | — | Phase 2 |
| T18 | Lost or duplicated lifecycle events break revocation or erasure | Transactional outbox; at-least-once delivery; consumers idempotent by event identifier and version; access never depends on an event | `shared/events.ts` | Contract implemented; outbox phase 2 |
| T19 | A group name identifies a person ("Alice's book club") | Group names never appear in events, logs, directory or disclosure answers; personal groups have no name; a valid correction or erasure request about a group name is met by a rename (iam-integration data-subject requests); administration pages advise against personal names | `tests/personal-data.test.ts` | Accepted risk with treatment, see §4 |
| T20 | Break-glass misuse | Break-glass identity kind; passkey only; three actions; never self-appointment; alert on every use; review closed by another person (ADR-0007) | `tests/approvals.test.ts` | Contract implemented; enforcement phase 2 |
| T21 | Impersonation ("act as") | Not provided by any port or function (ADR-0005 §2.2) | Architecture | Implemented |
| T22 | Unsafe policy changes by a host | Hard bounds; loosening past a default needs a risk-treatment reference | `tests/policy.test.ts` | Implemented |
| T23 | Correlation lost across members, so a process cannot be audited | Correlation identifier on every port call, pending change and event | `shared/events.ts`, `shared/ports.ts` | Implemented (contract) |

## 4. Deferred controls and risk treatments

| Gap | Risk | Treatment |
|---|---|---|
| No storage, server functions or endpoints yet | Hosts cannot yet run Identity | Phases 2 to 4 |
| Confusable data is a subset of UTS #39 | Rare look-alikes pass the sibling check | Phase 2 server code may load the full confusables table; mixed-script names are already refused |
| Bearer invitations left `immediate` (T15) | A forwarded member invitation admits someone other than the intended person | Treated 2026-10-09 (design decisions §11): guests need confirmation by default and any group can require it for members. Remaining risk, for member invitations a group leaves `immediate`, is accepted: 14-day expiry, single use, the inviter is told who joined and can remove them, and invitations to existing identities are bound |
| Group names can name a person (T19) | Personal data in an organisational field | Accepted with treatment 2026-10-09 (design decisions §11): names are needed for groups to be usable. Contained (safe names only, never in events, logs or port answers; personal groups have none). Profile's erasure does not reach them, so a valid correction or erasure request is met by the owners renaming the group (`identity.groups:rename`, `medium`), or by a platform operator with a reason code if the owners do not act before the deadline. Administration pages (phase 5) advise against personal names and warn when a name matches its creator's display name |
| `simple-git` 3.36.0 advisories GHSA-x6jw-m9v5-85vh (critical), GHSA-858h-whjf-mvg5 and GHSA-g4wm-2vf7-vfgr (high), allow-listed in `dependency-review.yml` | Command execution if an attacker controls `simple-git` arguments or Git configuration | Accepted 2026-10-09, review by 2027-01-09. Reached only through `nuxt` → `@nuxt/devtools` (a devDependency, never installed into hosts), with fixed arguments on the local checkout in `nuxt dev` only. Remove once devtools depends on a patched `simple-git` |
| `braces` 3.0.3 advisory GHSA-vfj7-8cjw-p6xm (high), allow-listed | Denial of service from a deeply nested brace pattern | Accepted 2026-10-09, review by 2027-01-09. Reached only through build-time globbing of the project's own configuration, never user input. Remove once a patched release exists |
| `node-forge` 1.4.0 advisory GHSA-86w9-cpqp-85rv (high), allow-listed | Forged RSA signatures accepted by verification | Accepted 2026-10-09, review by 2027-01-09. Reached only through `listhen`'s self-signed certificate for `nuxt dev --https`, which never verifies signatures. Remove once a patched release exists |
