# ADR-011: SQLite-backed Stage 1A local persistence

**Status:** Accepted, development-only.

## Decision

Stage 1A replaces the default executable persistence path with `SqliteDurableLedger`, backed by Node 24's built-in `node:sqlite` module. The legacy `LocalDurableLedger` remains only as a supported one-time import source and compatibility implementation; it is not the recommended Stage 1A runtime ledger.

The SQLite ledger uses a versioned schema (`schema_migrations`), WAL journal mode, `synchronous=FULL`, `BEGIN IMMEDIATE` transactions, a 10-second SQLite busy timeout, and SQL `UNIQUE`/primary-key guards for envelopes/nonces, Orders/correlations, Payment Links, captures, webhook deliveries, policy decisions, authorisations, and execution identities. The authorisation and execution state changes occur in the same transaction as their guards. Audit events are append-only in a dedicated table protected by update/delete-aborting triggers.

## Rationale

The atomically replaced JSON file was useful for Stage 1, but it could leave a stale directory lock on process failure, had no database-enforced cross-process constraints, rewrote mutable audit history as one document, and provided no schema migration or native online backup facility. Those gaps are material for the Stage 1A concurrency and recovery tests.

`node:sqlite` is built into the validated Node 24.13.1 runtime, adding no package dependency and keeping this development-only store isolated from Neon, HomeBound, and all production data services. It emits Node's experimental SQLite warning at this runtime; that status and the Node 24 runtime requirement are explicit limitations.

## Recovery and migration

`createBackup()` uses SQLite's online backup API. `restoreBackupToNewFile()` refuses to overwrite an existing target. `importLegacyJsonLedger()` imports exactly one prior Stage 1 JSON ledger into an empty SQLite ledger and reconstructs all SQL guards; it refuses a merge into a non-empty database. Operators must verify a backup by opening it at a new path before selecting it as a recovery candidate.

## Consequences

The ledger is ACID for a single local SQLite file and supports cross-process locking on a compatible local filesystem. It is not a multi-region, hosted, encrypted-key-management, or production persistence solution. It does not turn a PayPal capture into settlement, payout eligibility, or production authority. A later production architecture needs a separately reviewed store, operational backup policy, encryption/access controls, and recovery drills.
