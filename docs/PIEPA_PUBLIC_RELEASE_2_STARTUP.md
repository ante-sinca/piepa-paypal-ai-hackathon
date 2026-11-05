# PIEPA Public Release 2 — Clean Startup

This update corrects only the initial state of the local PIEPA switchboard.
It does not create a PayPal Order, collect a payment, authorise a simulation,
execute a payout, alter a signature, or modify durable records.

## Behaviour

- The default instruction amount is **GBP 1.00**.
- PIEPA reports Ollama Local AI as available only after a bounded, read-only
  check confirms that the configured model appears in the local inventory.
  This check does not send an inference request.
- A confirmed available Ollama model is selected for drafting, but generation
  begins only when the operator selects **Generate New Instruction**.
- If the configured model is unavailable, the operator is shown the Offline
  Demo alternative.
- Startup loads the persisted-instruction inventory only. It never selects or
  restores an instruction automatically; recovery requires the explicit
  **Recover Selected Instruction** action and remains read-only.

## Safety boundary

AI can draft a proposal but cannot authorise collection, sign a payment,
verify an external payment, or execute a payout. PayPal activity remains
identified as Sandbox activity, and the Philippine payout demonstration is
simulated only.
