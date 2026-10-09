# @nuxt4-layers/identity — notes for Claude

## What this is
Nuxt 4 foundation layer for identity (which identity is this, and what is it a member of, in which state?).
A member of the IAM suite (ADR-0005). Governed by `nuxt4-layers/platform-architecture`; persistence follows ADR-0002 and ADR-0006. Cross-member processes live in `nuxt4-layers/iam-integration`. British spelling everywhere, including code and the manifest.

## Commands
- `pnpm install`, then `pnpm dev:prepare` for Nuxt types. Never add a `prepare`/`postinstall` script: Git installs would then pull devDependencies into hosts
- `pnpm check` = `nuxt typecheck` + `vitest run`; run it after every code change
- `pnpm build:playground` proves the layer composes in a host
- Single test file: `pnpm vitest run tests/<name>.test.ts`
- `python3 scripts/check_markdown.py` checks headings, local links and pinned cross-repository links; run it after every documentation change

## Rules
- **No personal data.** Identity holds opaque identifiers, states, dates, codes and group names only. Never names, email addresses, phone numbers, free text about a person, or a hash of any of them. Personal data is Profile's; sign-in identifiers are Authentication's. `tests/personal-data.test.ts` must stay green: every record, event and port-answer schema is a strict object, and every string in it is an identifier, a code, a timestamp, a digest or a safe group name.
- Contract (`contracts/`, `shared/`, `conformance/`) imports only zod. No Nuxt, Vue, h3, server code, drivers or other `@nuxt4-layers/*` packages. Enforced by `tests/contracts.test.ts`.
- Public surface: package root, `./contracts`, `./conformance`, `./capability`, the `provide*` server functions. `server/internal` is private.
- Members never import one another. Authentication, Authorisation and Profile reach Identity through ports the host supplies; Identity reaches Authorisation through its access-decision and approval-policy ports.
- Follow the Group Model Definition: personal group atomic with the identity, single parent, no cycles, no implicit inheritance, membership-derived revocation.
- Self-sovereignty: nobody else acts in a personal group. No "act as". No self-grant at any risk level outside one's own personal group. Approvals follow iam-integration's `docs/processes/approvals.md`: pending changes record requester, beneficiary and justification; groups may raise approval requirements, never lower them.
- Errors stay coarse: `forbidden` never reveals whether an identity, group, membership or invitation exists.
- Required ports fail closed. No implicit in-memory or file fallback stores.
- Events and logs carry opaque identifiers, codes and correlation identifiers only.
- Defaults are secure; loosening a safety period or limit needs a documented risk treatment.
- Keep `docs/contracts.md`, `docs/threat-model.md` (control register) and `docs/roadmap.md` in step with code. Link to other `nuxt4-layers` documents pinned to a commit.
- Package manager: pnpm. Commit `pnpm-lock.yaml`.
