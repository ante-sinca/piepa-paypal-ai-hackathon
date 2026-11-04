import type { PayoutAuthorisation } from "../contracts/envelope.js";
import type { MockExecutionAttempt } from "../persistence/local-ledger.js";
import type { Stage1Persistence } from "../persistence/contracts.js";

export type MockPayoutScenario = "SUCCEEDED" | "FAILED" | "REJECTED" | "TIMEOUT" | "AMBIGUOUS" | "RETURNED";

/** No network implementation exists here. Results are explicitly simulated Philippine domestic payout outcomes. */
export class MockPhilippinesPayoutAdapter {
  readonly provider = "mock-philippines" as const;
  constructor(private readonly ledger: Stage1Persistence) {}

  async execute(authorisation: PayoutAuthorisation, scenario: MockPayoutScenario): Promise<MockExecutionAttempt> {
    if (authorisation.payoutProvider !== this.provider) throw new Error("Attempted production or unsupported payout adapter execution");
    const claim = await this.ledger.beginMockExecution(authorisation.authorisationId);
    if (!claim.created || claim.attempt.outcome !== "IN_PROGRESS") return claim.attempt; // retry preserves the original execution identity and does not make another attempt
    return this.ledger.finishMockExecution(claim.attempt.executionId, scenario);
  }
}
