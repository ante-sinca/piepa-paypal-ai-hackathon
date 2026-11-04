# PIEPA — Payment Instruction Envelope Protocol Agent

**AI-assisted. Human-authorised. Independently verified.**

PIEPA is a local, open-source hackathon demonstration of a deliberately constrained payment-instruction lifecycle:

`AI draft → human review → Ed25519-signed envelope → PayPal Sandbox Order → independent evidence retrieval → deterministic policy → single-use mock payout authorisation → simulated Philippine payout → reconciliation`

Its central question is: can a genuine PayPal-hosted **Sandbox** checkout be securely connected to an independently authorised, cryptographically signed instruction that permits exactly one **simulated** Philippine payout after verified funding?

The answer demonstrated here is architectural, not a production remittance offering. AI drafting has no authority to approve, sign, verify, authorise, or execute a payment or payout.

## What PIEPA demonstrates

- A constrained instruction draft from either a repeatable offline synthetic adapter or optional Ollama Local AI.
- Deterministic field validation followed by explicit, digest-bound human approval.
- Ed25519 signing and verification of a canonical payment-instruction envelope.
- PayPal **Sandbox Orders v2** collection, with an independently retrieved Order and capture as the only acceptable payment evidence.
- Evidence-gated, single-use authorisation and idempotent mock execution.
- Durable local SQLite records, read-only recovery, and reconciliation status.

The judge-facing interface deliberately separates the normal workflow from its technical/recovery details. It binds to `127.0.0.1` only.

## Quick start

Prerequisite: Node.js 20 or newer.

```sh
git clone https://github.com/ante-sinca/piepa-paypal-ai-hackathon.git
cd piepa-paypal-ai-hackathon
npm ci
npm run check
npm run demo
```

Open `http://127.0.0.1:3030/`. Select **Offline Demo**, generate an instruction using synthetic fixtures, review it, approve it, sign it, then run the simulated workflow. The resulting receipt is explicitly synthetic; it creates neither a PayPal transaction nor a real payout.

`npm run check` runs TypeScript validation, a build, and the complete Node test suite. `npm run demo` rebuilds and starts the loopback-only operator interface.

## Configuration

Copy `.env.example` to an ignored `.env`; placeholders only belong in the example file. Do not commit the local file, PayPal credentials, database files, or generated Ed25519 keys.

```sh
copy .env.example .env
```

On macOS/Linux use `cp .env.example .env`. The offline synthetic demo needs no provider credentials.

### Ollama Local AI

PIEPA supports genuine local drafting with Ollama and `qwen2.5-coder:7b` by default. Start Ollama locally, make the model available, then set:

```dotenv
HBIEPA_AI_PROVIDER=ollama
HBIEPA_OLLAMA_MODEL=qwen2.5-coder:7b
HBIEPA_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The application accepts only a loopback Ollama URL. Local inference can take more than a minute on CPU. If inference fails, PIEPA reports the failure; it never silently substitutes synthetic output. The offline mode is intentionally labelled `SYNTHETIC_AI_DEMO` and is not AI inference.

### PayPal Sandbox

Use only your own PayPal Developer **Sandbox** application and buyer account. Set the following local values:

```dotenv
PAYPAL_SANDBOX_CLIENT_ID=<your-sandbox-client-id>
PAYPAL_SANDBOX_CLIENT_SECRET=<your-sandbox-client-secret>
PAYPAL_SANDBOX_MERCHANT_ID=<your-sandbox-merchant-id>
PAYPAL_API_ORIGIN=https://api-m.sandbox.paypal.com
HBIEPA_OPERATION_MODE=sandbox-simulation
HBIEPA_SANDBOX_RETURN_URL=https://example.com/your-return
HBIEPA_SANDBOX_CANCEL_URL=https://example.com/your-cancel
```

The configuration loader rejects every origin except the exact PayPal Sandbox API origin and rejects every operation mode except `sandbox-simulation`. The preflight performs read-only Sandbox OAuth before a new Order may be created. For every Order and capture, PIEPA independently retrieves evidence and checks the configured merchant, correlation, amount, currency, status, and capture identity. A browser return is never payment evidence.

To exercise the optional Sandbox path: generate, review, approve, and sign an instruction; create a Sandbox Order; complete checkout manually with your Sandbox buyer; then choose **Verify Payment**. Only a matching independently retrieved completed capture enables **Authorise Simulation**, followed by exactly one simulated payout. Do not enter production credentials or production endpoints.

## Security architecture

PIEPA’s safety boundaries are implemented in the application rather than trusted to the model or UI:

- The canonical envelope is Ed25519-signed; altered payloads and invalid signatures are rejected.
- Approval is explicit, human-recorded, and bound to the reviewed instruction digest.
- PayPal callback/redirect data cannot advance the lifecycle. Provider evidence must be independently retrieved.
- Sandbox Orders are bound to an opaque correlation value and expected amount, currency, and merchant.
- A durable ledger consumes authorisation before mock execution, blocking replay and duplicate execution.
- Recovery is read-only and cannot create a replacement approval, signature, Order, capture, authorisation, or payout.
- Ambiguous, invalid, incomplete, duplicate, expired, and mismatched states fail closed.
- The only supplied payout adapter is `mock-philippines`; it has no external remittance capability.

Read the [architecture](docs/ARCHITECTURE.md), [envelope specification](docs/ENVELOPE_SPECIFICATION.md), [state machine](docs/STATE_MACHINE.md), [threat model](docs/THREAT_MODEL.md), and [security notes](docs/SECURITY.md) for more detail.

## PayPal integration versus simulation

| Capability | Implementation | What it means |
| --- | --- | --- |
| Collection | PayPal Sandbox Orders v2 | A real Sandbox API interaction using credentials supplied locally by the operator. |
| Payment evidence | Authenticated retrieval of the Order/capture | A matching completed capture is required; redirects are insufficient. |
| AI drafting | Ollama Local AI, optional | Model output is an untrusted draft and never an authorisation. |
| Offline demo | Synthetic drafting/payment fixtures | Repeatable test/demo behaviour; not a PayPal or AI claim. |
| Philippine payout | `mock-philippines` adapter | Simulated only; no money, bank, wallet, or remittance service is contacted. |

## Testing and reproducible demonstration

Run the full suite with:

```sh
npm run check
```

The suite covers signing, tamper detection, validation, state transitions, invalid signatures, provider mismatches, independently retrieved evidence, duplicate authorisation/execution protection, persistence/recovery, UI script parsing, and the judge-facing layout. Tests use generated test keys and synthetic fixtures; no production services are called.

For a visual synthetic demonstration, use `npm run demo` and the offline path described in Quick start. A fresh clone creates new local data under the ignored `.hbiepa-data/` directory. Stop the process and delete that directory locally if you want a fresh demonstration state.

## Limitations

- PayPal usage is Sandbox-only. PIEPA is not configured for production PayPal endpoints.
- The Philippine payout is simulated. PIEPA does not offer a production remittance, payout, bank, wallet, Coins.ph, Xoom, or money-transfer service.
- Local development keys and SQLite persistence are suitable for a demonstration only. Production would require managed keys, authenticated roles, secure retention/access controls, regulated partners, provider approval, and an independent security/compliance review.
- This project does not imply PayPal approval, sponsorship, or endorsement of a production financial service.

## Licence

MIT © 2026 Ante Sinca. See [LICENSE](LICENSE). Third-party runtime dependencies retain their own licences; see `package-lock.json` and the attribution note in [docs/SECURITY.md](docs/SECURITY.md).
