# Changelog

All notable changes to `@nuxt4-layers/identity`. The package follows [semantic versioning](https://semver.org/), and contract version 1 is frozen for 1.x.

## 1.0.0 (2026-10-11)

The first stable release: everything in contract version 1 ([docs/contracts.md](docs/contracts.md)).

- Identities with provisioning, pausing, suspension, closure and recovery holds; tenants; groups with a single parent, personal groups, owners, safety periods and approvals; memberships, guests and invitations; service identities.
- PostgreSQL storage with row-level security per tenant, a runtime role that owns nothing, and a transactional outbox.
- End of life: group deletion, tenant closure, legal holds, disposal tracking and retention.
- Break-glass accounts, the conformance suite for directory adapters, the `/api/identity/*` endpoints and the accessible default pages.
