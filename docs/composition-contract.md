# Identity Composition Contract

## 1. Purpose

How a host Nuxt application composes the identity capability. The host is the composition root. Identity is a bounded foundation capability in the IAM suite ([ADR-0005](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0005-iam-suite.md)).

## 2. Package composition

Install through the package manager and compose the package root with Nuxt `extends`:

- during early development, use a Git-backed dependency **pinned to a tag or commit SHA**. The package runs no install-time scripts, so only its runtime dependency (`zod`) is installed;
- commit the lockfile and install with `--frozen-lockfile` in CI;
- never follow a mutable default branch in production.

Compose Identity as a **peer** of Authentication, Profile and Authorisation. It does not extend, and is not extended by, any of them.

## 3. Dependency graph

```text
Authentication ── reserve / confirm / signInStatus ──► IdentityProvisioning ──┐
                                                                              │
Authorisation ◄── host adapter ◄── IdentityDirectory ◄────────────────────────┤
                                                                              │ Identity
Profile ◄── IdentityDisclosureContextPort ◄───────────────────────────────────┤
                                                                              │
Authorisation ── host adapters ──► IdentityAccessDecision, IdentityApprovalPolicy
                                                                              │
Host outbox relay ◄── identity outbox ── IdentityEventPublisher ◄─────────────┘
        │
        └──► Authentication, Profile, Authorisation, notifications, audit
```

Identity has **no package dependency** on any other member, database vendor SDK or UI. Its manifest declares Authorisation and Authentication as required **capabilities**: the host connects their contracts to Identity's. Reference adapters for these connections will live in `nuxt4-layers/iam-integration`.

## 4. Host responsibilities

The host application:

- selects a compatible version and pins it;
- creates two PostgreSQL roles: a **migration role** that owns the `identity` schema, and a **runtime role** that owns nothing, is not a superuser and does not have `BYPASSRLS`;
- applies migrations at deployment with `migrateIdentityDatabase({ pool: migrationPool, runtimeRole })`, which refuses a runtime role that could bypass row-level security;
- supplies the **runtime** pool through `provideIdentityDatabase` (required);
- schedules `runIdentityMaintenance()` every few minutes and `relayIdentityOutbox({ limit })` frequently (every few seconds to a minute), from a Nitro scheduled task, a cron job or a queue. Both are idempotent and safe on several instances. Access never depends on them: states and dates are evaluated on every read. The playground's `server/tasks/identity/maintenance.ts` shows one way;
- runs the platform operator's procedures with the **migration** pool, never from an HTTP route: `provisionIdentityTenant({ pool, jurisdiction, dataRegion, ... })` provisions a tenant, and `bootstrapIdentityRootGroup({ pool, tenantId, name, firstOwnerId, ... })` creates its first root group and founding owner, once. The runtime role can do neither; every later root group is an approved `group.create-root` change;
- relays Authentication's `authentication.credentials-recovered` to `recordIdentityCredentialRecovery(...)`, so that `critical` changes requested soon after a recovery are held;
- provisions break-glass identities, if it uses them, with `provisionIdentityBreakGlass({ pool, homeTenantId, ... })` and the migration pool, under its written break-glass procedure (ADR-0007), and turns every `break-glass.used` into an alert to every platform operator and affected owner;
- designates a **platform group** (`provideIdentityPolicy({ platformGroupId })`): a standard group whose owners and qualifying members are the platform's operators. Root groups, suspending or reinstating an identity, objections to an orphaned group's recovery and closing break-glass reviews are decided there; without one, those are refused;
- supplies `provideIdentityAccessDecision` (required), adapting Authorisation's decision for Identity's permissions. It must reject on failure, never allow;
- supplies `provideIdentityApprovalPolicy` (required), adapting Authorisation's catalogue risk levels and the principals who hold a permission in a group. Every read is `strong`;
- supplies `provideIdentityEventPublisher` (required), the publishing end of its outbox relay;
- adds `IDENTITY_PERMISSIONS` to Authorisation's catalogue;
- optionally supplies policy overrides through `provideIdentityPolicy`, within bounds;
- adapts Identity's provided ports for their consumers:
  - `IdentityProvisioning` to Authentication's provisioning port, called from the engine's user-creation hook (`reserve`) and after verification (`confirm`);
  - `IdentityDirectory` to Authorisation's `AuthorisationDirectory`, mapping an effective status of `paused` to `suspended` while Authorisation is on contract 2;
  - `IdentityDisclosureContextPort` to Profile's disclosure-context port;
- runs the directory conformance suite (`@nuxt4-layers/identity/conformance`) against every directory adapter it supplies, including any cache;
- integration-tests the composed system, including negative tests for tenant isolation and for leaving a group.

Example Nitro plugin:

```ts
import { IDENTITY_PERMISSIONS } from '@nuxt4-layers/identity/contracts'

export default defineNitroPlugin(() => {
  provideIdentityDatabase({ dialect: 'postgres', pool })
  provideIdentityAccessDecision(authorisationDecisionAdapter)
  provideIdentityApprovalPolicy(authorisationApprovalAdapter)
  provideIdentityEventPublisher(outboxRelay)
  provideIdentityPolicy({ platformGroupId: process.env.IDENTITY_PLATFORM_GROUP_ID ?? null })
  provideAuthorisationPermissions(IDENTITY_PERMISSIONS)
})
```

## 5. Layer responsibilities

The identity layer:

- owns identities, personal groups, groups, the hierarchy, tenants, memberships, invitations, group settings, pending governance changes and break-glass reviews;
- owns the `identity` database schema, its migrations and its outbox (phase 2);
- asks Authorisation for every decision it does not reserve to the person themselves;
- publishes the events in [the contract](contracts.md) §11 through its outbox;
- fails closed when a required port is absent, or the database or Authorisation fails.

## 6. Persistence and store inventory

Identity follows ADR-0002 and the [Data Store Security Standard v0.1](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/standards/data-store-security-v01.md) §1:

| Field | Value |
|---|---|
| Kind | Relational (PostgreSQL). The membership graph is small and relational; no graph database is needed |
| Port | `provideIdentityDatabase({ dialect: 'postgres', pool, schema? })`, a `pg`-compatible pool |
| Holds | Identities, external identifiers, tenants, groups, memberships, invitations (token digests only), group settings, pending changes, break-glass reviews, the outbox. System of record for all of them |
| Classification | No personal data, no secrets, no credentials. Opaque identifiers, codes, instants, digests and group names |
| Isolation | Tenant-isolated tables (`tenant`, `group`, `membership`, `identity_external_id`, `pending_change`, `invitation`, `join_request`) carry `tenant_id` and use row-level security on the transaction-local `identity.tenant_ids`; with none set, the runtime role sees nothing. Tables that span tenants (`identity`, `outbox`, `provisioning_request`, `acceptance_attempt`, `founding_claim`, `break_glass_review`) are not granted to the runtime role: it reaches them only through SECURITY DEFINER functions with a fixed `search_path` that return exactly a port's answer. The runtime role neither owns anything nor has `BYPASSRLS`. Its writes are limited to inserting child groups and memberships (a guard trigger refuses root groups and self-made owners) and to the columns phase 2b changes (a guard trigger refuses reviving an ended membership, reinstating a suspended one, and suspending or removing an owner). It may only read pending changes, invitations and join requests: recording, deciding, cancelling and applying them run through SECURITY DEFINER functions that check the rules again. Events are written by triggers and those functions, never by the runtime role. It cannot create tenants or root groups at all: the operator's procedures use the migration role |
| Erasure | Nothing to erase about a person: anonymisation is Profile's deletion of its record. A closed identity's identifier remains, referring to nobody the platform can name |
| Rebuild | Not applicable: no derived copies. A host cache in front of the directory port must pass the conformance suite |

- The host creates and owns both pools: credentials, TLS, pooling mode and lifecycle. Migration credentials MUST be separate from runtime credentials and unavailable to request handling (Data Store Security Standard §2.5).
- Transaction pooling (for example PgBouncer in transaction mode) is safe: the tenant setting is transaction-local and never outlives the transaction.
- The layer reads and writes only its own schema, `identity` by default. A host may rename it to another lower-case PostgreSQL identifier.
- No other capability reads the `identity` schema. Other members store Identity's identifiers as opaque values with no cross-schema foreign keys.
- Migrations are applied before Authentication's, Profile's and Authorisation's (iam-integration architecture §6).

## 7. Failure boundaries

| Condition | Behaviour |
|---|---|
| Required port missing | `IdentityCompositionError` at first use. The operation is refused. No fallback store, decision or publisher |
| Invalid port shape or schema name | `TypeError` from the `provide*` call at startup |
| Invalid policy, or a loosening without a risk treatment | `TypeError` or a validation error from `provideIdentityPolicy` at startup |
| Authorisation unreachable or failing | `unavailable` (503); the change is refused |
| Database failure | `unavailable` (503); provided ports reject |
| Approval-policy port failing, or missing a permission from its catalogue | `unavailable` (503); the change is neither recorded nor decided |
| No platform group designated | Root groups and identity suspension are refused (`forbidden`) |
| An approved or due change whose rule no longer holds when it applies | The change is recorded `rejected`, with the reason kept for operators; `approval.decided` says so |
| Event publisher failure | The event stays in the outbox and is retried; the committed change stands. Later events wait for the next run, so each aggregate's order is kept |
| Outbox event that does not match the contract | Never published; logged by sequence number (no payload) for an operator to inspect |
| Runtime role that can bypass row-level security, or is the migration role | `migrateIdentityDatabase` refuses to run |

## 8. Composed-system verification

A consuming application must test its own combination of the pinned Identity version, its adapters to and from Authentication, Authorisation and Profile, its database and its outbox relay. The layer's tests establish its contract; they cannot establish the correctness of a host's adapters. The conformance suite covers the directory adapter; iam-integration's composition tests (its roadmap phase 4) will cover the processes end to end.
