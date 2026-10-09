# Security policy

`@nuxt4-layers/identity` holds the membership graph that every access
decision reads, so we treat security reports as our highest priority.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request.** Report privately
through GitHub: [Security → Report a vulnerability](https://github.com/nuxt4-layers/identity/security/advisories/new).

Please include the affected version or commit, the impact, and the steps or a
proof of concept to reproduce it. Never include real users' credentials or
personal data.

We aim to acknowledge a report within 3 working days and to agree a fix and
disclosure date with you within 14 days. We credit reporters in the advisory
unless you ask us not to.

## Supported versions

Before 1.0, only the latest release on `master` receives fixes.

## Scope

In scope: this repository's layer code and endpoints, and its
documented defaults (see `docs/threat-model.md`).
Vulnerabilities in dependencies should go to their
maintainers; tell us too if the layer's use of them is affected.

Out of scope: findings that need a host to loosen the documented secure
defaults, and denial of service by volume alone.

Please test only against your own local or disposable deployments.
