# @nuxt4-layers/identity

> **AI-Driven Development**
>
> This repository is part of [Nuxt 4 Layers](https://github.com/nuxt4-layers), an experimental, AI-driven software engineering initiative.
>
> AI performs the principal architecture, development, testing, security assessment and documentation activities under human direction. The project owner retains authority over requirements, governance, acceptance and releases.
>
> **Our objective is to demonstrate that disciplined, specification-led AI development can deliver secure, maintainable, standards-compliant, production-quality open-source software.**
>
> All contributions are subject to the same engineering standards, quality controls and repository policies, regardless of origin. See the [AI development methodology](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/AI_DEVELOPMENT.md).

A Nuxt 4 foundation layer that answers one question for the rest of the platform: **which identity is this, and what is it a member of, in which state?**

Part of the `nuxt4-layers` Identity and Access Management (IAM) suite, with [`authentication`](https://github.com/nuxt4-layers/authentication), [`profile`](https://github.com/nuxt4-layers/profile), [`authorisation`](https://github.com/nuxt4-layers/authorisation) and [`iam-integration`](https://github.com/nuxt4-layers/iam-integration).

**Status:** phase 3 of 6. The contract, conformance suite, composition ports, PostgreSQL storage with row-level security, the outbox, provisioning, the directory and disclosure-context ports, child groups, membership changes, the governance approvals engine, invitations and join requests are in place; the identity lifecycle, recovery and administration follow (see [docs/roadmap.md](docs/roadmap.md)).

## Owns

- Opaque identity identifiers (UUIDv7) for people and services, and their lifecycle.
- One system-managed personal (unary) group per human identity.
- Groups, the single-parent hierarchy, and tenants (a separate module, extractable later).
- Memberships, their kinds (`member`, `guest`), dates and states.
- Group governance settings, including the departure data policy, and pending governance changes awaiting approval.

## Never owns

| Not here | Owned by |
|---|---|
| Names, contact details or any other personal data that describes a person | Profile |
| Credentials, sign-in identifiers and sessions | Authentication |
| Roles, assignments, grants and access decisions | Authorisation |
| Organisation, club, committee and other domain records | Domain capabilities, which reference group identifiers |

Group relationships do not confer access. Identity reports structure and state; Authorisation decides.

## Governing decisions

- [ADR-0002 — Composition-Supplied Persistence and Capability-Owned Schemas](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0002-composition-supplied-persistence-and-capability-owned-schemas.md)
- [ADR-0003 — Group Model and Identity Before Logging](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0003-group-model-and-identity-first.md), which accepts the [Group Model Definition v0.1](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/identity/group-model-definition-v01.md)
- [ADR-0004 — Documentation Placement](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0004-documentation-placement.md)
- [ADR-0005 — Identity and Access Management Suite](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0005-iam-suite.md)
- [ADR-0006 — Polyglot Persistence and Data-Store Security](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0006-polyglot-persistence-and-data-store-security.md) and the [Data Store Security Standard v0.1](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/standards/data-store-security-v01.md)
- [ADR-0007 — Break-Glass Emergency Access](https://github.com/nuxt4-layers/platform-architecture/blob/93f3d6fb144b72d61cfb172b6a50eb6c5af9f489/docs/decisions/ADR-0007-break-glass-emergency-access.md)

The suite architecture, state models and cross-capability processes are specified in [`iam-integration`](https://github.com/nuxt4-layers/iam-integration/blob/d46b16580a711b840edb1eef5db51b2fe3d0421f/docs/architecture.md).

## Documentation

- [Contract](docs/contracts.md): identities, tenants, groups, memberships, invitations, approvals, ports and events
- [Composition contract](docs/composition-contract.md): what a host supplies, and the store inventory
- [Threat model and control register](docs/threat-model.md)
- [Design decisions](docs/design-decisions.md): the Identity design round, including the Better Auth verification
- [Roadmap](docs/roadmap.md), including Profile's dependencies on Identity

## Using it

```ts
// nuxt.config.ts of the host
export default defineNuxtConfig({
  extends: ['@nuxt4-layers/identity'],
})
```

```ts
// server/plugins/identity.ts of the host
export default defineNitroPlugin(async () => {
  // At deployment, with the migration role's pool:
  await migrateIdentityDatabase({ pool: migrationPool, runtimeRole: 'identity_runtime' })
  // At request time, with the runtime role's pool:
  provideIdentityDatabase({ dialect: 'postgres', pool: runtimePool })
  provideIdentityAccessDecision(authorisationDecisionAdapter)
  provideIdentityApprovalPolicy(authorisationApprovalAdapter)
  provideIdentityEventPublisher(outboxRelay)
  provideIdentityPolicy({ platformGroupId })
})
```

The operator provisions tenants and each tenant's first root group with the migration pool, from a server-only procedure: `provisionIdentityTenant({ pool: migrationPool, ... })` and `bootstrapIdentityRootGroup({ pool: migrationPool, ... })`. Every other governance change goes through `getIdentityApprovals()`.

Other members import types only from `@nuxt4-layers/identity/contracts`, and directory adapters are tested with `@nuxt4-layers/identity/conformance`.

Schedule `runIdentityMaintenance()` and `relayIdentityOutbox()` with any scheduler; see `playground/server/tasks/identity/maintenance.ts`.

## Development

```sh
pnpm install
pnpm dev:prepare
pnpm check                       # nuxt typecheck + vitest
pnpm build:playground            # proves the layer composes in a host
python3 scripts/check_markdown.py
```

Requires Node 22 and pnpm 10.

## Licence

MIT
