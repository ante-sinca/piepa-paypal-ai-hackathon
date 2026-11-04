# PIEPA Public Release 1 report

**Release verdict:** PARTIAL — staged release verified; GitHub publication blocked by repository authorisation.

## Security audit

- The audited development source is `c8ae6013668b4817c9a451d3071f0be2eae46e04` on `codex/piepa-hackathon-recovery-final-1`.
- The source working tree had one untracked PayPal recovery diagnosis. It was preserved locally and deliberately excluded from the public release.
- Pattern-based scanning of all source files proposed for release and all reachable development commits found no PayPal client secret, OAuth token, API token, private-key block, Ed25519 seed, or common cloud credential pattern. Values were not printed during the audit.
- A populated local `.env`, local generated key material, SQLite ledger files, journal sidecars, and runtime/test directories exist in the development workspace. They were not copied and are ignored in the release.
- Historical operational reports and evidence manifests were excluded because they contain local transaction/account metadata that is unnecessary for independent reproduction.
- The original source embedded a non-secret Sandbox merchant identifier and a derived client-ID fingerprint in its preflight gate. The release removes those account-specific values so they are not disclosed and judges can configure their own Sandbox account. It retains exact Sandbox-origin enforcement, authenticated preflight, and bound Order/capture verification using the configured merchant.
- The clean public repository has a new initial history only. No development commits, branches, tags, or historical blobs are transferred.

## Excluded files and content

- `.env` and all populated environment files.
- `.hbiepa-data/`, SQLite databases and `-wal`/`-shm` sidecars, generated demo keys, logs, `dist/`, `node_modules/`, coverage, and test workspaces.
- The untracked `docs/PIEPA_PAYPAL_VERIFY_1_DIAGNOSIS.md` local diagnosis.
- Historical test/acceptance reports, evidence manifests, and Devpost working drafts that record local provider or transaction metadata.

## Application and reproducibility verification

- Clean dependency installation: `npm ci --ignore-scripts` completed successfully.
- Automated validation: `npm run check` passed — 64 tests passed, 0 failed.
- Dependency advisory check: `npm audit --omit=dev --audit-level=low` found 0 vulnerabilities.
- A read-only local recovery inspection confirmed the requested GBP 100.00 reconciled record exists. It did not print record data and did not mutate the ledger, create a PayPal Order, capture a payment, or execute a payout.
- The release retains the accepted judge-facing UI, recovered-instruction display, read-only recovery, signing, evidence gates, authorisation consumption, and mock-only execution tests.

## Open-source compliance

- Licence: MIT, with `Copyright (c) 2026 Ante Sinca`.
- Copyright holder for this publication: Ante Sinca, the authorised repository owner/publisher.
- The MIT notice covers original PIEPA source and documentation only. Node.js, npm, PayPal, Ollama, and package dependencies remain governed by their respective terms and licences; attribution is documented in `SECURITY.md`.

## Proposed public contents

- Audited TypeScript source, scripts, complete automated tests, `package.json`, lockfile, TypeScript configuration, `.env.example`, `.gitignore`, README, MIT licence, security notes, and non-transactional architecture/specification/ADR documentation.
- No provider credentials, private signing keys, local ledger records, personal transaction data, production endpoints, or real payout adapter.

## Publication

- Destination: `https://github.com/ante-sinca/piepa-paypal-ai-hackathon`
- Branch: `main`
- Local source commit: `c8ae6013668b4817c9a451d3071f0be2eae46e04`
- Publication attempt: blocked before upload. GitHub returned HTTP 403 because the configured identity, `rolf-cains`, does not have write permission for `ante-sinca/piepa-paypal-ai-hackathon`.
- Public commit: none. No remote branch or commit was created.
- Required action: authenticate Git with an account granted write access to `ante-sinca/piepa-paypal-ai-hackathon`, then push this already audited staging repository's `main` branch without force-pushing.
- Remote match verification: not applicable until a successful authorised push.

## Final status

**PARTIAL — all local security, licence, reproducibility, and simulation-only gates passed, but publication is blocked by GitHub write authorisation.** Do not claim public release verification until an authorised push and independent remote fetch succeed.
