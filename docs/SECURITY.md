# Security and release boundaries

## Reporting and local secrets

Do not file public issues containing credentials, tokens, private keys, personal data, provider order/capture IDs, webhook payloads, or local ledger records. Rotate a credential if it may have been exposed and replace the local value before continuing.

`.env`, key/certificate extensions, logs, SQLite files, generated data, build output, test workspaces, and dependencies are ignored. `.env.example` contains configuration names, safe endpoints, and empty placeholders only; it is not a credential source.

## Demonstration keys and data

The demo generates an Ed25519 key pair locally in `.hbiepa-data/` with restrictive local file permissions. It is demonstrative material, never a deployment key, and is not committed. Tests generate their own keys and use fictional/synthetic references. A clean clone includes no database, transaction record, private key, webhook event, or PayPal account identity.

## Provider and execution boundaries

The configuration loader permits only `https://api-m.sandbox.paypal.com` and `sandbox-simulation`. PayPal credentials are used only by the local server-side Sandbox adapter. The exact configured merchant is checked against retrieved Order/capture evidence. Redirects are not evidence; invalid, absent, incomplete, mismatched, ambiguous, and duplicate states block downstream execution.

The mock Philippines adapter cannot communicate with an external financial institution. There is no production endpoint selector or production payout adapter.

## Third-party attribution

This repository's direct development dependencies are TypeScript and Node type definitions, recorded in `package-lock.json`. Node.js, npm, PayPal services, Ollama, and all dependencies are separate third-party products governed by their own licences and terms. This MIT licence covers the original PIEPA source and documentation only.
