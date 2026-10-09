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

**Status:** design round complete; phase 1 (foundation) in progress.

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

The suite architecture, state models and cross-capability processes are specified in [`iam-integration`](https://github.com/nuxt4-layers/iam-integration/blob/19df31458bab5a5190ab6590e58ef01ceabf9533/docs/architecture.md).

## Documentation checks

`python3 scripts/check_markdown.py` checks headings, local links, and that links to other `nuxt4-layers` documents are pinned to a tag or commit.

## Licence

MIT
