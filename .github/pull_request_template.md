## What and why

## How it was tested

- [ ] `pnpm check` passes
- [ ] `python3 scripts/check_markdown.py` passes, if documentation changed
- [ ] Database suites run (or CI), if server code changed

## Security and privacy checklist

- [ ] No personal data in schemas, events, logs or test fixtures: identifiers, codes, timestamps and group names only
- [ ] No secrets, tokens or email addresses in events, logs or test fixtures
- [ ] No new dependency, or the new dependency is justified below (maintenance, install scripts, licence)
- [ ] `docs/contracts.md`, `docs/threat-model.md` and `docs/roadmap.md` updated if behaviour changed
- [ ] Defaults stay secure; any loosening has a documented risk treatment

Vulnerabilities must not be disclosed in a pull request: see [SECURITY.md](../SECURITY.md).
